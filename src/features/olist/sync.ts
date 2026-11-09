import type { D1Database, R2Bucket } from '@cloudflare/workers-types';
import { generatePublicId } from '../ids/publicId';
import { htmlParaMarkdown, numeroOuNulo, reaisParaCentavos, rotuloGrade, slugify } from './texto';

/**
 * Sincronização do catálogo Olist → loja. SOMENTE LEITURA no Olist: nenhuma
 * chamada aqui grava nada lá (regra do dono — escrita no Olist só sob comando).
 *
 * Roda aos poucos, numa máquina de estados guardada no settings:
 *   listar   → percorre produtos.pesquisa e enche olist_fila (pais, simples e variações)
 *   detalhar → produto.obter de cada pai/simples; entra na loja só se a marca bater
 *   estoque  → produto.obter.estoque em ciclo, do item conferido há mais tempo
 * A cada 24 h a listagem recomeça para pegar produto novo e preço alterado.
 *
 * Teto de chamadas por rodada: o limite da API é POR CONTA e o PCP usa a mesma.
 */
const API = 'https://api.tiny.com.br/api2';
const LISTAR_PAGINAS_POR_RODADA = 4;
const DETALHAR_POR_RODADA = 8;
const ESTOQUE_POR_RODADA = 15;
const RELISTAR_HORAS = 24;
const MAX_IMAGENS = 6;

export interface EstadoSync {
  fase: 'listar' | 'detalhar' | 'estoque';
  pagina: number;
  listado_em: string | null;
  ultima_rodada: string | null;
  ultimo_erro: string | null;
  importados: number;
}

const ESTADO_INICIAL: EstadoSync = {
  fase: 'listar',
  pagina: 1,
  listado_em: null,
  ultima_rodada: null,
  ultimo_erro: null,
  importados: 0,
};

class ErroOlist extends Error {}

async function chamar(token: string, endpoint: string, params: Record<string, string> = {}) {
  const body = new URLSearchParams({ token, formato: 'json', ...params });
  const res = await fetch(`${API}/${endpoint}.php`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  const texto = await res.text();
  if (!res.ok) throw new ErroOlist(`Olist ${endpoint} respondeu ${res.status}`);
  let j: { retorno?: Record<string, unknown> };
  try {
    j = JSON.parse(texto);
  } catch {
    throw new ErroOlist(`Olist ${endpoint}: resposta ilegível`);
  }
  const r = j.retorno ?? {};
  if (r.status !== 'OK') {
    const erros = (r.erros as { erro?: string }[] | undefined)?.map((e) => e.erro).join('; ');
    // codigo_erro 20 = "a consulta não retornou registros" — não é falha.
    if (String(r.codigo_erro) === '20') return { ...r, vazio: true };
    throw new ErroOlist(`Olist ${endpoint}: ${erros || r.codigo_erro || 'erro'}`);
  }
  return r;
}

export async function lerEstado(db: D1Database): Promise<EstadoSync> {
  const row = await db.prepare("SELECT value FROM settings WHERE key = 'olist_sync'").first<{ value: string }>();
  if (!row) return { ...ESTADO_INICIAL };
  try {
    return { ...ESTADO_INICIAL, ...(JSON.parse(row.value) as Partial<EstadoSync>) };
  } catch {
    return { ...ESTADO_INICIAL };
  }
}

async function gravarEstado(db: D1Database, e: EstadoSync): Promise<void> {
  await db
    .prepare("INSERT INTO settings(key, value) VALUES('olist_sync', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(JSON.stringify(e))
    .run();
}

/* ---------------------------------------------------------------- listar */

async function listar(db: D1Database, token: string, e: EstadoSync): Promise<void> {
  for (let i = 0; i < LISTAR_PAGINAS_POR_RODADA; i++) {
    const r = await chamar(token, 'produtos.pesquisa', { pagina: String(e.pagina), situacao: 'A' });
    const produtos = ((r.produtos as { produto: Record<string, unknown> }[] | undefined) ?? []).map((p) => p.produto);
    const stmts = produtos.map((p) =>
      db
        .prepare(
          `INSERT INTO olist_fila (olist_id, tipo, nome, codigo, preco_cents, gtin, estado, atualizado)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'novo', datetime('now'))
           ON CONFLICT(olist_id) DO UPDATE SET
             nome = excluded.nome, codigo = excluded.codigo, preco_cents = excluded.preco_cents,
             gtin = excluded.gtin, atualizado = excluded.atualizado,
             -- relistagem diária: pai/simples volta para "novo" para reler detalhes
             estado = CASE WHEN olist_fila.tipo IN ('P','N') AND olist_fila.estado <> 'ignorado' THEN 'novo' ELSE olist_fila.estado END`,
        )
        .bind(
          String(p.id),
          String(p.tipoVariacao ?? 'N'),
          String(p.nome ?? ''),
          String(p.codigo ?? ''),
          reaisParaCentavos(p.preco_promocional && Number(p.preco_promocional) > 0 ? p.preco_promocional : p.preco),
          String(p.gtin ?? '') || null,
        ),
    );
    if (stmts.length) await db.batch(stmts);
    // Variação já na loja: atualiza preço e EAN direto, sem esperar o pai ser relido.
    const variacoes = produtos.filter((p) => p.tipoVariacao === 'V');
    if (variacoes.length) {
      await db.batch(
        variacoes.map((p) =>
          db
            .prepare('UPDATE product_variants SET price_cents = ?, gtin = COALESCE(?, gtin) WHERE olist_id = ?')
            .bind(
              reaisParaCentavos(p.preco_promocional && Number(p.preco_promocional) > 0 ? p.preco_promocional : p.preco),
              String(p.gtin ?? '') || null,
              String(p.id),
            ),
        ),
      );
    }
    const total = Number(r.numero_paginas ?? 1);
    if (r.vazio || e.pagina >= total) {
      e.fase = 'detalhar';
      e.pagina = 1;
      e.listado_em = new Date().toISOString();
      return;
    }
    e.pagina += 1;
  }
}

/* -------------------------------------------------------------- detalhar */

async function copiarImagem(db: D1Database, bucket: R2Bucket, url: string): Promise<string | null> {
  const ja = await db.prepare('SELECT image_key FROM olist_imagens WHERE url = ?').bind(url).first<{ image_key: string }>();
  if (ja) return ja.image_key;
  const res = await fetch(url);
  if (!res.ok) return null;
  const tipo = res.headers.get('content-type') ?? 'image/jpeg';
  if (!/^image\/(jpeg|png|webp|gif)/.test(tipo)) return null;
  const dados = await res.arrayBuffer();
  if (dados.byteLength > 8 * 1024 * 1024) return null;
  const ext = tipo.includes('png') ? 'png' : tipo.includes('webp') ? 'webp' : tipo.includes('gif') ? 'gif' : 'jpg';
  const key = `products/olist-${crypto.randomUUID()}.${ext}`;
  await bucket.put(key, dados, {
    httpMetadata: { contentType: tipo, cacheControl: 'public, max-age=31536000, immutable' },
  });
  const nome = decodeURIComponent(url.split('/').pop() ?? 'imagem');
  await db.batch([
    db
      .prepare(
        'INSERT INTO media (image_key, original_name, mime_type, size_bytes, public_id) VALUES (?, ?, ?, ?, ?)',
      )
      .bind(key, nome.slice(0, 120), tipo, dados.byteLength, generatePublicId('media')),
    db.prepare('INSERT INTO olist_imagens (url, image_key) VALUES (?, ?)').bind(url, key),
  ]);
  return key;
}

async function slugLivre(db: D1Database, base: string, olistId: string): Promise<string> {
  const s = slugify(base) || `produto-${olistId}`;
  const usado = await db
    .prepare('SELECT 1 FROM products WHERE slug = ? AND (olist_id IS NULL OR olist_id <> ?)')
    .bind(s, olistId)
    .first();
  return usado ? `${s}-${olistId}`.slice(0, 100) : s;
}

async function detalhar(
  db: D1Database,
  bucket: R2Bucket,
  token: string,
  marca: string,
  currency: string,
  e: EstadoSync,
): Promise<void> {
  const { results } = await db
    .prepare("SELECT olist_id, preco_cents FROM olist_fila WHERE estado = 'novo' AND tipo IN ('P','N') ORDER BY olist_id LIMIT ?")
    .bind(DETALHAR_POR_RODADA)
    .all<{ olist_id: string; preco_cents: number }>();
  if (!results.length) {
    e.fase = 'estoque';
    return;
  }
  for (const item of results) {
    try {
      const r = await chamar(token, 'produto.obter', { id: item.olist_id });
      const p = (r.produto ?? {}) as Record<string, unknown>;
      const marcaProduto = String(p.marca ?? '').trim().toLowerCase();
      const entra = marcaProduto === marca.toLowerCase() && reaisParaCentavos(p.preco) > 0;
      if (!entra) {
        await db.prepare("UPDATE olist_fila SET estado = 'ignorado' WHERE olist_id = ?").bind(item.olist_id).run();
        // Produto que estava na loja e trocou de marca ou zerou o preço: sai de vitrine.
        await db.prepare('UPDATE products SET active = 0 WHERE olist_id = ?').bind(item.olist_id).run();
        continue;
      }
      await gravarProduto(db, bucket, p, currency);
      await db.prepare("UPDATE olist_fila SET estado = 'ok' WHERE olist_id = ?").bind(item.olist_id).run();
      e.importados += 1;
    } catch (err) {
      await db
        .prepare("UPDATE olist_fila SET tentativas = tentativas + 1, estado = CASE WHEN tentativas >= 2 THEN 'erro' ELSE estado END WHERE olist_id = ?")
        .bind(item.olist_id)
        .run();
      if (err instanceof ErroOlist && /bloquead|excedid|limite/i.test(err.message)) throw err;
      e.ultimo_erro = `${item.olist_id}: ${(err as Error).message}`.slice(0, 300);
    }
  }
}

async function gravarProduto(db: D1Database, bucket: R2Bucket, p: Record<string, unknown>, currency: string) {
  const olistId = String(p.id);
  const nome = String(p.nome ?? '').trim();
  const precoCents = reaisParaCentavos(
    p.preco_promocional && Number(p.preco_promocional) > 0 ? p.preco_promocional : p.preco,
  );
  const descricao = htmlParaMarkdown(String(p.descricao_complementar ?? '') || String(p.obs ?? ''));
  const pesoKg = numeroOuNulo(p.peso_bruto) ?? numeroOuNulo(p.peso_liquido);
  const pesoGramas = pesoKg ? Math.round(pesoKg * 1000) : null;
  const variacoes = (p.variacoes as { variacao: Record<string, unknown> }[] | '' | undefined) || [];
  const grupo = variacoes.length ? rotuloGrade(variacoes[0].variacao.grade).grupo : null;

  const existente = await db
    .prepare('SELECT id, slug FROM products WHERE olist_id = ?')
    .bind(olistId)
    .first<{ id: number; slug: string }>();
  const slug = existente?.slug ?? (await slugLivre(db, String(p.slug ?? '') || nome, olistId));

  let productId: number;
  const campos = [
    nome, descricao, precoCents, currency, pesoGramas, String(p.codigo ?? '') || null,
    String(p.gtin ?? '') || null, String(p.marca ?? '') || null,
    numeroOuNulo(p.comprimentoEmbalagem), numeroOuNulo(p.larguraEmbalagem), numeroOuNulo(p.alturaEmbalagem),
    grupo,
  ];
  if (existente) {
    productId = existente.id;
    await db
      .prepare(
        `UPDATE products SET name = ?, description = ?, price_cents = ?, currency = ?, weight_grams = ?, sku = ?,
           gtin = ?, brand = ?, length_cm = ?, width_cm = ?, height_cm = ?, variant_label = ?,
           olist_synced_at = datetime('now')
         WHERE id = ?`,
      )
      .bind(...campos, productId)
      .run();
  } else {
    const row = await db
      .prepare(
        `INSERT INTO products (name, description, price_cents, currency, weight_grams, sku, gtin, brand,
           length_cm, width_cm, height_cm, variant_label, slug, stock, active, requires_shipping, olist_id,
           public_id, olist_synced_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1, 1, ?, ?, datetime('now'))
         RETURNING id`,
      )
      .bind(...campos, slug, olistId, generatePublicId('product'))
      .first<{ id: number }>();
    productId = row!.id;
  }

  // Imagens: copia para o R2 só na primeira vez (galeria vazia).
  const temImagem = await db.prepare('SELECT 1 FROM product_images WHERE product_id = ?').bind(productId).first();
  if (!temImagem) {
    const urls = [
      ...((p.anexos as { anexo: string }[] | undefined) ?? []).map((a) => a.anexo),
      ...((p.imagens_externas as { imagem_externa?: { url?: string } }[] | undefined) ?? [])
        .map((i) => i.imagem_externa?.url ?? ''),
    ].filter((u) => /^https:\/\//.test(u)).slice(0, MAX_IMAGENS);
    let posicao = 0;
    for (const url of urls) {
      const key = await copiarImagem(db, bucket, url);
      if (!key) continue;
      await db
        .prepare('INSERT INTO product_images (product_id, image_key, position, public_id) VALUES (?, ?, ?, ?)')
        .bind(productId, key, posicao, generatePublicId('productImage'))
        .run();
      if (posicao === 0) await db.prepare('UPDATE products SET image_key = ? WHERE id = ?').bind(key, productId).run();
      posicao += 1;
    }
  }

  // Variações: uma por variação do Olist; preço e EAN vêm da fila (listagem).
  for (const [i, v] of variacoes.map((x) => x.variacao).entries()) {
    const vid = String(v.id);
    const fila = await db
      .prepare('SELECT preco_cents, gtin FROM olist_fila WHERE olist_id = ?')
      .bind(vid)
      .first<{ preco_cents: number; gtin: string | null }>();
    const preco = fila?.preco_cents || reaisParaCentavos(
      v.preco_promocional && Number(v.preco_promocional) > 0 ? v.preco_promocional : v.preco,
    );
    const { rotulo } = rotuloGrade(v.grade);
    const ja = await db.prepare('SELECT id FROM product_variants WHERE olist_id = ?').bind(vid).first<{ id: number }>();
    if (ja) {
      await db
        .prepare('UPDATE product_variants SET label = ?, price_cents = ?, sku = ?, gtin = ?, position = ?, active = 1 WHERE id = ?')
        .bind(rotulo || String(v.codigo ?? vid), preco, String(v.codigo ?? '') || null, fila?.gtin ?? null, i, ja.id)
        .run();
    } else {
      await db
        .prepare(
          `INSERT INTO product_variants (product_id, label, price_cents, stock, sku, position, olist_id, gtin, public_id)
           VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?)`,
        )
        .bind(productId, rotulo || String(v.codigo ?? vid), preco, String(v.codigo ?? '') || null, i, vid,
          fila?.gtin ?? null, generatePublicId('variant'))
        .run();
    }
  }
  // Variação que sumiu do Olist sai da vitrine.
  if (variacoes.length) {
    const ids = variacoes.map((x) => String(x.variacao.id));
    await db
      .prepare(
        `UPDATE product_variants SET active = 0 WHERE product_id = ? AND olist_id IS NOT NULL
           AND olist_id NOT IN (${ids.map(() => '?').join(',')})`,
      )
      .bind(productId, ...ids)
      .run();
  }
}

/* --------------------------------------------------------------- estoque */

async function estoque(db: D1Database, token: string): Promise<void> {
  // Item (variação ou produto simples) conferido há mais tempo primeiro.
  const { results } = await db
    .prepare(
      `SELECT 'v' AS t, v.id, v.olist_id, v.stock_checked_at AS c FROM product_variants v
         JOIN products p ON p.id = v.product_id WHERE v.olist_id IS NOT NULL AND v.active = 1
       UNION ALL
       SELECT 'p' AS t, p.id, p.olist_id, p.olist_synced_at AS c FROM products p
         WHERE p.olist_id IS NOT NULL AND p.variant_label IS NULL
       ORDER BY c IS NOT NULL, c LIMIT ?`,
    )
    .bind(ESTOQUE_POR_RODADA)
    .all<{ t: 'v' | 'p'; id: number; olist_id: string }>();
  for (const it of results) {
    const r = await chamar(token, 'produto.obter.estoque', { id: it.olist_id });
    const prod = (r.produto ?? {}) as { saldo?: number; saldoReservado?: number };
    const disponivel = Math.max(0, Math.floor(Number(prod.saldo ?? 0) - Number(prod.saldoReservado ?? 0)));
    if (it.t === 'v') {
      await db
        .prepare("UPDATE product_variants SET stock = ?, stock_checked_at = datetime('now') WHERE id = ?")
        .bind(disponivel, it.id)
        .run();
    } else {
      await db
        .prepare("UPDATE products SET stock = ?, olist_synced_at = datetime('now') WHERE id = ?")
        .bind(disponivel, it.id)
        .run();
    }
  }
}

/* ----------------------------------------------------------------- rodada */

/**
 * Uma rodada da sincronização. Chamada pelo cron (a cada 5 min) e pelo botão
 * "Sincronizar agora" do admin. Nunca lança: o erro fica registrado no estado.
 */
export async function rodadaOlist(
  db: D1Database,
  bucket: R2Bucket,
  token: string,
  marca: string,
  currency: string,
): Promise<EstadoSync> {
  const e = await lerEstado(db);
  try {
    if (
      e.fase !== 'listar' &&
      (!e.listado_em || Date.now() - Date.parse(e.listado_em) > RELISTAR_HORAS * 3600_000)
    ) {
      e.fase = 'listar';
      e.pagina = 1;
    }
    if (e.fase === 'listar') await listar(db, token, e);
    else if (e.fase === 'detalhar') await detalhar(db, bucket, token, marca, currency, e);
    else await estoque(db, token);
    if (e.fase !== 'detalhar') e.ultimo_erro = null;
  } catch (err) {
    e.ultimo_erro = (err as Error).message.slice(0, 300);
  }
  e.ultima_rodada = new Date().toISOString();
  await gravarEstado(db, e);
  return e;
}
