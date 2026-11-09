import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { getSetting } from '../../../features/settings/db';

export const prerender = false;

/**
 * Avisos que o Olist manda para a loja (modelo Nuvemshop):
 *   /api/olist/produtos  → "Enviar para o e-commerce" no Olist: o produto entra na loja
 *   /api/olist/estoque?chave=…   → estoque mudou: a loja reconfere aquele item primeiro
 *   /api/olist/precos?chave=…    → preço mudou: a loja relê o produto
 *
 * O aviso não é assinado, então a chave aleatória na URL é a autenticação, e o
 * aviso só marca o que reler — o dado em si sempre vem da API do Olist (a loja
 * nunca confia no corpo do aviso para preço ou estoque).
 */
const EVENTOS = ['produtos', 'estoque', 'precos'] as const;
type Evento = (typeof EVENTOS)[number];

type Obj = Record<string, unknown>;
const ehObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const id = (v: unknown) => {
  const s = String(v ?? '').trim();
  return /^\d+$/.test(s) ? s : null;
};

/** Ids de produto no Olist, nos formatos conhecidos do aviso. */
function extrairIds(corpo: unknown): { ids: string[]; dados: Obj | null } {
  const ids = new Set<string>();
  const raiz = ehObj(corpo) ? corpo : {};
  const dados = ehObj(raiz.dados) ? raiz.dados : null;
  for (const fonte of [dados, raiz]) {
    if (!fonte) continue;
    for (const k of ['idProduto', 'id_produto', 'id']) {
      const v = id(fonte[k]);
      if (v) {
        ids.add(v);
        break;
      }
    }
    for (const lista of [fonte.produtos, fonte.itens]) {
      if (!Array.isArray(lista)) continue;
      for (const it of lista) {
        const o = ehObj(it) && ehObj(it.produto) ? it.produto : it;
        if (ehObj(o)) {
          const v = id(o.idProduto) ?? id(o.id);
          if (v) ids.add(v);
        }
      }
    }
  }
  return { ids: [...ids].slice(0, 50), dados };
}

export const POST: APIRoute = async ({ request, params, url }) => {
  const evento = params.evento as Evento;
  if (!EVENTOS.includes(evento)) return new Response('evento desconhecido', { status: 404 });
  // Sem chave por decisão do dono (09/11/2026): o aviso só pede para a loja RELER
  // o produto na API do Olist — nada no corpo é confiado e nada é gravado no Olist.
  // Chave antiga na URL continua aceita; chave errada é recusada.
  const chave = await getSetting(env.DB, 'olist_aviso_chave');
  const enviada = url.searchParams.get('chave');
  if (enviada && enviada !== chave) return new Response('chave inválida', { status: 401 });

  const texto = (await request.text()).slice(0, 200_000);
  let corpo: unknown = null;
  try {
    corpo = JSON.parse(texto);
  } catch {
    // Formulário (dados=JSON) também é aceito.
    const f = new URLSearchParams(texto);
    const bruto = f.get('dados') ?? f.get('json');
    if (bruto) {
      try {
        corpo = { dados: JSON.parse(bruto) };
      } catch {
        corpo = null;
      }
    }
  }
  const { ids, dados } = extrairIds(corpo);
  const db = env.DB;
  // Aviso de preço não traz o id do produto: acha pelo código (SKU) na loja.
  if (!ids.length && dados) {
    for (const k of ['codigo', 'sku', 'skuMapeamentoPai', 'skuMapeamento']) {
      const cod = String(dados[k] ?? '').trim();
      if (!cod) continue;
      const achado =
        (await db.prepare('SELECT p.olist_id FROM product_variants v JOIN products p ON p.id = v.product_id WHERE v.sku = ? AND p.olist_id IS NOT NULL').bind(cod).first<{ olist_id: string }>()) ??
        (await db.prepare('SELECT olist_id FROM products WHERE sku = ? AND olist_id IS NOT NULL').bind(cod).first<{ olist_id: string }>());
      if (achado) {
        ids.push(achado.olist_id);
        break;
      }
    }
  }
  await db
    .prepare('INSERT INTO olist_avisos (evento, corpo, ids) VALUES (?, ?, ?)')
    .bind(evento, texto.slice(0, 20_000), ids.join(','))
    .run();
  await db.prepare('DELETE FROM olist_avisos WHERE id <= (SELECT MAX(id) - 200 FROM olist_avisos)').run();

  for (const oid of ids) {
    if (evento === 'estoque') {
      await db.prepare('UPDATE product_variants SET stock_checked_at = NULL WHERE olist_id = ?').bind(oid).run();
      await db.prepare('UPDATE products SET olist_synced_at = NULL WHERE olist_id = ?').bind(oid).run();
      continue;
    }
    // produtos e preços: (re)ler o produto pai inteiro pela API.
    const pai =
      (await db
        .prepare('SELECT p.olist_id FROM product_variants v JOIN products p ON p.id = v.product_id WHERE v.olist_id = ?')
        .bind(oid)
        .first<{ olist_id: string }>())?.olist_id ?? oid;
    await db
      .prepare(
        `INSERT INTO olist_fila (olist_id, tipo, nome, estado, origem, tentativas, atualizado)
         VALUES (?, 'P', ?, 'enviado', 'aviso', 0, datetime('now'))
         ON CONFLICT(olist_id) DO UPDATE SET
           estado = CASE WHEN olist_fila.tipo = 'V' THEN olist_fila.estado ELSE 'enviado' END,
           origem = CASE WHEN olist_fila.tipo = 'V' THEN olist_fila.origem ELSE 'aviso' END,
           tentativas = 0, atualizado = datetime('now')`,
      )
      .bind(pai, String(dados?.nome ?? '').slice(0, 200) || pai)
      .run();
  }

  if (evento === 'produtos' && dados && id(dados.id)) {
    const variacoes = (Array.isArray(dados.variacoes) ? dados.variacoes : [])
      .map((v) => (ehObj(v) && ehObj(v.variacao) ? v.variacao : v))
      .filter(ehObj)
      .filter((v) => id(v.id));
    // Fotos ficam na variação (uma por cor): guarda as URLs para a importação.
    for (const v of variacoes) {
      const fotos = (Array.isArray(v.anexos) ? v.anexos : [])
        .map((a) => (ehObj(a) ? String(a.url ?? a.anexo ?? '') : String(a ?? '')))
        .filter((u) => /^https:\/\//.test(u))
        .slice(0, 3);
      for (const [pos, u] of fotos.entries()) {
        await db
          .prepare('INSERT INTO olist_var_imagens (olist_id, pos, url) VALUES (?, ?, ?) ON CONFLICT(olist_id, pos) DO UPDATE SET url = excluded.url')
          .bind(String(v.id), pos, u)
          .run();
      }
    }
    // Vínculo produto ↔ loja: devolve o MESMO idMapeamento que o Olist mandou,
    // com o código da loja (skuMapeamento). Sem isso o Olist acusa "não mapeado".
    // Formato que o Olist (Tiny) espera: lista plana, produto + cada variação.
    const sku = (o: Obj) => String(o.codigo ?? o.sku ?? '').trim() || String(o.id);
    return Response.json(
      [dados, ...variacoes].map((o) => ({ idMapeamento: String(o.idMapeamento || o.id), skuMapeamento: sku(o) })),
    );
  }
  return Response.json({ status: 'processado', ids: ids.length });
};
