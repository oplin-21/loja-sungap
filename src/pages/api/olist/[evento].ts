import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { getSetting } from '../../../features/settings/db';

export const prerender = false;

/**
 * Avisos que o Olist manda para a loja (modelo Nuvemshop):
 *   /api/olist/produtos?chave=…  → "Enviar para o e-commerce" no Olist: o produto entra na loja
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
  const chave = await getSetting(env.DB, 'olist_aviso_chave');
  if (!chave || url.searchParams.get('chave') !== chave) return new Response('chave inválida', { status: 401 });

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
    // O Olist registra o vínculo produto ↔ loja com estes códigos.
    const variacoes = Array.isArray(dados.variacoes) ? dados.variacoes : [];
    return Response.json({
      idMapeamento: String(dados.id),
      skuMapeamento: String(dados.codigo ?? dados.sku ?? dados.id),
      variacoes: variacoes
        .map((v) => (ehObj(v) && ehObj(v.variacao) ? v.variacao : v))
        .filter(ehObj)
        .filter((v) => id(v.id))
        .map((v) => ({ id: String(v.id), idMapeamento: String(v.id), skuMapeamento: String(v.codigo ?? v.sku ?? v.id) })),
    });
  }
  return Response.json({ status: 'processado', ids: ids.length });
};
