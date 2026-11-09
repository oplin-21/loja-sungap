import type { D1Database } from '@cloudflare/workers-types';
import { chamar, ErroOlist } from './sync';

/**
 * Pedido pago da loja → pedido de venda no Olist, no mesmo molde da Nuvemshop:
 * cliente completo (CPF/CNPJ, endereço, telefone, e-mail — o Olist cria ou
 * atualiza o contato), itens pelo id do produto no Olist, frete, desconto,
 * número do pedido da loja e a situação "aprovado".
 *
 * ESCRITA NO OLIST — autorizada pelo dono em 09/11/2026 só para isto.
 * Contra duplicação (já houve incidente): antes de criar, procura no Olist um
 * pedido com o mesmo número da loja; e cada pedido é "reservado" por um UPDATE
 * condicional antes da chamada, então dois crons nunca enviam o mesmo pedido.
 */

export interface EnderecoLoja {
  name?: string | null;
  line1?: string | null;
  line2?: string | null;
  number?: string | null;
  district?: string | null;
  city?: string | null;
  state?: string | null;
  postal?: string | null;
  document?: string | null;
  phone?: string | null;
}

export interface ItemPedido {
  nome: string;
  precoCents: number;
  quantidade: number;
  olistId: string | null;
  sku: string | null;
}

export interface DadosPedido {
  referencia: string; // número do pedido na loja (o que o cliente vê)
  criadoEm: string; // 'YYYY-MM-DD HH:MM:SS' (UTC, como o D1 grava)
  email: string | null;
  endereco: EnderecoLoja;
  itens: ItemPedido[];
  freteCents: number;
  freteNome: string | null;
  descontoCents: number;
  meioPagamento: string;
  idEcommerce: string | null;
  nomeLoja: string;
}

const so = (v: unknown) => String(v ?? '').replace(/\D+/g, '');
const reais = (c: number) => (Math.round(c) / 100).toFixed(2);

/** Data do pedido em dd/mm/aaaa no horário de Brasília. */
export function dataBrasil(utc: string): string {
  const d = new Date(utc.includes('T') ? utc : `${utc.replace(' ', 'T')}Z`);
  const p = new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(Number.isNaN(d.getTime()) ? new Date() : d);
  return p;
}

/** Monta o JSON que o Olist espera em pedido.incluir (chave "pedido"). Puro, testável. */
export function montarPedido(d: DadosPedido, comVinculo = true): Record<string, unknown> {
  const e = d.endereco;
  const doc = so(e.document);
  const tipo = doc.length === 14 ? 'J' : 'F';
  const cliente = {
    nome: String(e.name ?? '').trim() || d.email || 'Cliente da loja',
    tipo_pessoa: tipo,
    cpf_cnpj: doc,
    endereco: e.line1 ?? '',
    numero: e.number ?? '',
    complemento: e.line2 ?? '',
    bairro: e.district ?? '',
    cep: so(e.postal),
    cidade: e.city ?? '',
    uf: e.state ?? '',
    pais: 'Brasil',
    fone: so(e.phone),
    email: d.email ?? '',
    atualizar_cliente: 'S',
  };
  const itens = d.itens.map((i) => ({
    item: {
      ...(i.olistId ? { id_produto: i.olistId } : {}),
      ...(i.sku ? { codigo: i.sku } : {}),
      descricao: i.nome.slice(0, 120),
      unidade: 'UN',
      quantidade: String(i.quantidade),
      valor_unitario: reais(i.precoCents),
    },
  }));
  const pedido: Record<string, unknown> = {
    data_pedido: dataBrasil(d.criadoEm),
    numero_pedido_ecommerce: d.referencia,
    ecommerce: d.nomeLoja.slice(0, 50),
    situacao: 'aprovado',
    cliente,
    endereco_entrega: {
      tipo_pessoa: tipo,
      cpf_cnpj: doc,
      endereco: cliente.endereco,
      numero: cliente.numero,
      complemento: cliente.complemento,
      bairro: cliente.bairro,
      cep: cliente.cep,
      cidade: cliente.cidade,
      uf: cliente.uf,
      fone: cliente.fone,
      nome_destinatario: cliente.nome,
    },
    itens,
    valor_frete: reais(d.freteCents),
    ...(d.freteNome ? { forma_frete: d.freteNome.slice(0, 30), nome_transportador: d.freteNome.slice(0, 100) } : {}),
    frete_por_conta: 'R',
    valor_desconto: reais(d.descontoCents),
    meio_pagamento: d.meioPagamento,
    obs: `Pedido ${d.referencia} da loja online — pago via ${d.meioPagamento}`.slice(0, 100),
  };
  if (comVinculo && d.idEcommerce) pedido.id_ecommerce = d.idEcommerce;
  return { pedido };
}

/* ------------------------------------------------------------- envio real */

interface LinhaPedido {
  id: number;
  public_id: string | null;
  email: string | null;
  shipping_cents: number;
  shipping_label: string | null;
  discount_cents: number;
  ship_address: string | null;
  payment_method: string | null;
  created_at: string;
  olist_tentativas: number;
}

const MAX_TENTATIVAS = 5;
const POR_RODADA = 3;

/** Já existe no Olist um pedido com este número da loja? Devolve id/número. */
async function procurar(token: string, referencia: string): Promise<{ id: string; numero: string } | null> {
  const r = await chamar(token, 'pedidos.pesquisa', { numeroEcommerce: referencia });
  if ((r as { vazio?: boolean }).vazio) return null;
  const lista = (r.pedidos as { pedido: { id: unknown; numero: unknown; numero_ecommerce?: unknown } }[] | undefined) ?? [];
  const achado = lista.find((p) => String(p.pedido.numero_ecommerce ?? '') === referencia);
  return achado ? { id: String(achado.pedido.id), numero: String(achado.pedido.numero) } : null;
}

async function incluir(token: string, corpo: Record<string, unknown>): Promise<{ id: string; numero: string }> {
  const r = await chamar(token, 'pedido.incluir', { pedido: JSON.stringify(corpo) });
  const reg = (r.registros as { registro: Record<string, unknown> }[] | undefined)?.[0]?.registro;
  if (!reg || reg.status !== 'OK') {
    const erros = (reg?.erros as { erro?: string }[] | undefined)?.map((e) => e.erro).join('; ');
    throw new ErroOlist(`Olist recusou o pedido: ${erros || 'sem detalhe'}`);
  }
  return { id: String(reg.id), numero: String(reg.numero) };
}

async function dadosDoPedido(
  db: D1Database,
  o: LinhaPedido,
  referencia: string,
  idEcommerce: string | null,
  nomeLoja: string,
): Promise<DadosPedido> {
  const { results } = await db
    .prepare(
      `SELECT oi.name, oi.price_cents, oi.quantity,
              COALESCE(v.olist_id, p.olist_id) AS olist_id,
              COALESCE(v.sku, p.sku) AS sku
         FROM order_items oi
         LEFT JOIN products p ON p.id = oi.product_id
         LEFT JOIN product_variants v ON v.id = oi.variant_id
        WHERE oi.order_id = ? ORDER BY oi.id`,
    )
    .bind(o.id)
    .all<{ name: string; price_cents: number; quantity: number; olist_id: string | null; sku: string | null }>();
  let endereco: EnderecoLoja = {};
  try {
    endereco = o.ship_address ? (JSON.parse(o.ship_address) as EnderecoLoja) : {};
  } catch {
    endereco = {};
  }
  return {
    referencia,
    criadoEm: o.created_at,
    email: o.email,
    endereco,
    itens: results.map((i) => ({
      nome: i.name,
      precoCents: i.price_cents,
      quantidade: i.quantity,
      olistId: i.olist_id,
      sku: i.sku,
    })),
    freteCents: o.shipping_cents ?? 0,
    freteNome: o.shipping_label,
    descontoCents: o.discount_cents ?? 0,
    meioPagamento: o.payment_method === 'infinitepay' ? 'InfinitePay' : String(o.payment_method ?? 'Loja online'),
    idEcommerce,
    nomeLoja,
  };
}

/**
 * Uma rodada: envia até 3 pedidos pagos que ainda não estão no Olist.
 * Chamada pelo cron (a cada 5 min).
 * Nunca lança: o erro fica gravado no próprio pedido.
 */
export async function enviarPedidosOlist(
  db: D1Database,
  token: string,
  opts: {
    idEcommerce: string | null;
    nomeLoja: string;
    referencia: (publicId: string | null, id: number) => string;
    somenteId?: number;
  },
): Promise<{ enviados: number; erros: number }> {
  const filtro = opts.somenteId ? 'AND id = ?' : '';
  const stmt = db.prepare(
    `SELECT id, public_id, email, shipping_cents, shipping_label, discount_cents, ship_address,
            payment_method, created_at, olist_tentativas
       FROM orders
      WHERE status = 'paid' AND COALESCE(payment_method, '') <> 'demo'
        AND (olist_estado IS NULL
             OR (olist_estado = 'erro' AND olist_tentativas < ${MAX_TENTATIVAS})
             OR (olist_estado = 'enviando' AND olist_tentado_em < datetime('now', '-10 minutes')))
        ${filtro}
      ORDER BY id LIMIT ${POR_RODADA}`,
  );
  const { results } = await (opts.somenteId ? stmt.bind(opts.somenteId) : stmt).all<LinhaPedido>();
  let enviados = 0;
  let erros = 0;
  for (const o of results) {
    // Reserva o pedido: só um cron/clique passa daqui.
    const reserva = await db
      .prepare(
        `UPDATE orders SET olist_estado = 'enviando', olist_tentativas = olist_tentativas + 1,
                olist_tentado_em = datetime('now')
          WHERE id = ? AND olist_tentativas = ? AND COALESCE(olist_estado, '') <> 'ok'`,
      )
      .bind(o.id, o.olist_tentativas)
      .run();
    if (!reserva.meta.changes) continue;
    const referencia = opts.referencia(o.public_id, o.id);
    try {
      let feito = await procurar(token, referencia);
      if (!feito) {
        const dados = await dadosDoPedido(db, o, referencia, opts.idEcommerce, opts.nomeLoja);
        try {
          feito = await incluir(token, montarPedido(dados, true));
        } catch (err) {
          // Vínculo com a integração recusado (ex.: integração ainda não instalada):
          // o pedido NÃO foi criado — tenta uma vez sem o vínculo.
          if (opts.idEcommerce && /id_ecommerce|integra[çc][ãa]o/i.test((err as Error).message)) {
            feito = (await procurar(token, referencia)) ?? (await incluir(token, montarPedido(dados, false)));
          } else throw err;
        }
      }
      await db
        .prepare(
          `UPDATE orders SET olist_estado = 'ok', olist_pedido_id = ?, olist_pedido_numero = ?, olist_erro = NULL
            WHERE id = ?`,
        )
        .bind(feito.id, feito.numero, o.id)
        .run();
      enviados += 1;
    } catch (err) {
      erros += 1;
      await db
        .prepare("UPDATE orders SET olist_estado = 'erro', olist_erro = ? WHERE id = ?")
        .bind((err as Error).message.slice(0, 300), o.id)
        .run();
      if (err instanceof ErroOlist && /bloquead|excedid|limite/i.test(err.message)) break;
    }
  }
  return { enviados, erros };
}
