import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { publicOrigin } from '../../features/http/origin';
import { getConfig } from '../../config';
import { mediaUrl } from '../../features/media/url';

export const prerender = false;

/**
 * Feed de produtos para o Google Merchant Center (RSS 2.0 com namespace g:).
 * Uma entrada por variação ativa (com item_group_id do produto) ou uma por
 * produto simples. Cadastre no Merchant: <loja>/feed/google.xml, busca diária.
 */
const esc = (s: unknown) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** Descrição em texto puro (o Google não aceita Markdown/HTML), até 5.000 caracteres. */
const textoPuro = (md: string | null) =>
  String(md ?? '')
    .replace(/\*\*/g, '')
    .replace(/^- /gm, '• ')
    .replace(/\s+\n/g, '\n')
    .trim()
    .slice(0, 4900);

interface Linha {
  id: number;
  public_id: string;
  name: string;
  slug: string;
  description: string | null;
  price_cents: number;
  stock: number;
  image_key: string | null;
  weight_grams: number | null;
  sku: string | null;
  gtin: string | null;
  brand: string | null;
  length_cm: number | null;
  width_cm: number | null;
  height_cm: number | null;
  variant_label: string | null;
  v_public_id: string | null;
  v_label: string | null;
  v_price: number | null;
  v_stock: number | null;
  v_sku: string | null;
  v_gtin: string | null;
  v_weight: number | null;
}

export const GET: APIRoute = async ({ request }) => {
  const origin = publicOrigin(new URL(request.url).origin, (env as unknown as Record<string, string | undefined>).CANONICAL_ORIGIN);
  const cfg = getConfig();
  const moeda = cfg.currency.toUpperCase();
  const loja =
    (await env.DB.prepare("SELECT value FROM settings WHERE key = 'store_name'").first<{ value: string }>())?.value ??
    'Loja';

  const { results } = await env.DB.prepare(
    `SELECT p.id, p.public_id, p.name, p.slug, p.description, p.price_cents, p.stock, p.image_key,
            p.weight_grams, p.sku, p.gtin, p.brand, p.length_cm, p.width_cm, p.height_cm, p.variant_label,
            v.public_id AS v_public_id, v.label AS v_label, v.price_cents AS v_price, v.stock AS v_stock,
            v.sku AS v_sku, v.gtin AS v_gtin, v.weight_grams AS v_weight
       FROM products p
       LEFT JOIN product_variants v ON v.product_id = p.id AND v.active = 1
      WHERE p.active = 1 AND p.price_cents > 0
      ORDER BY p.id, v.position`,
  ).all<Linha>();

  const itens = (results ?? []).map((r) => {
    const variacao = r.v_public_id != null;
    const id = variacao ? r.v_sku || r.v_public_id : r.sku || r.public_id;
    const preco = ((variacao ? r.v_price : r.price_cents) ?? r.price_cents) / 100;
    const estoque = (variacao ? r.v_stock : r.stock) ?? 0;
    const titulo = variacao && r.v_label ? `${r.name} - ${r.v_label}` : r.name;
    const link = `${origin}/products/${r.slug}${variacao ? `?variant=${r.v_public_id}` : ''}`;
    const imagem = r.image_key ? new URL(mediaUrl(r.image_key, cfg.images?.baseUrl ?? ''), origin).href : '';
    const gtin = variacao ? r.v_gtin : r.gtin;
    const peso = (variacao ? r.v_weight : null) ?? r.weight_grams;
    const cor = variacao && /cor/i.test(r.variant_label ?? '') ? r.v_label : null;
    return [
      '<item>',
      `<g:id>${esc(id)}</g:id>`,
      `<g:title>${esc(titulo.slice(0, 150))}</g:title>`,
      `<g:description>${esc(textoPuro(r.description) || titulo)}</g:description>`,
      `<g:link>${esc(link)}</g:link>`,
      imagem ? `<g:image_link>${esc(imagem)}</g:image_link>` : '',
      `<g:availability>${estoque > 0 ? 'in_stock' : 'out_of_stock'}</g:availability>`,
      `<g:price>${preco.toFixed(2)} ${moeda}</g:price>`,
      `<g:condition>new</g:condition>`,
      r.brand ? `<g:brand>${esc(r.brand)}</g:brand>` : `<g:brand>${esc(loja)}</g:brand>`,
      gtin ? `<g:gtin>${esc(gtin)}</g:gtin>` : `<g:identifier_exists>no</g:identifier_exists>`,
      (variacao ? r.v_sku : r.sku) ? `<g:mpn>${esc(variacao ? r.v_sku : r.sku)}</g:mpn>` : '',
      variacao ? `<g:item_group_id>${esc(r.sku || r.public_id)}</g:item_group_id>` : '',
      cor ? `<g:color>${esc(cor)}</g:color>` : '',
      peso ? `<g:shipping_weight>${(peso / 1000).toFixed(2)} kg</g:shipping_weight>` : '',
      r.length_cm ? `<g:shipping_length>${r.length_cm} cm</g:shipping_length>` : '',
      r.width_cm ? `<g:shipping_width>${r.width_cm} cm</g:shipping_width>` : '',
      r.height_cm ? `<g:shipping_height>${r.height_cm} cm</g:shipping_height>` : '',
      '</item>',
    ]
      .filter(Boolean)
      .join('');
  });

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0"><channel><title>${esc(loja)}</title><link>${esc(origin)}</link><description>${esc(loja)} — produtos</description>
${itens.join('\n')}
</channel></rss>`;

  return new Response(xml, {
    headers: {
      'content-type': 'application/xml; charset=utf-8',
      'cache-control': 'public, max-age=900',
    },
  });
};
