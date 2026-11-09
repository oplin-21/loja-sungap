/**
 * Cotação de frete no Melhor Envio (Correios e transportadoras) — só cotação.
 * A compra da etiqueta continua no painel do Melhor Envio (ou no Olist).
 */
export interface ItemFrete {
  id: string;
  /** centímetros */
  largura: number;
  altura: number;
  comprimento: number;
  /** quilos */
  pesoKg: number;
  valorCents: number;
  quantidade: number;
}

export interface OpcaoFrete {
  label: string;
  amountCents: number;
  prazoDias: number | null;
  servicoId: number;
}

const BASE = {
  producao: 'https://www.melhorenvio.com.br',
  teste: 'https://sandbox.melhorenvio.com.br',
};

export async function cotarFrete(params: {
  token: string;
  sandbox: boolean;
  cepOrigem: string;
  cepDestino: string;
  itens: ItemFrete[];
}): Promise<OpcaoFrete[]> {
  const so = (v: string) => v.replace(/\D+/g, '');
  const res = await fetch(`${params.sandbox ? BASE.teste : BASE.producao}/api/v2/me/shipment/calculate`, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      authorization: `Bearer ${params.token}`,
      'user-agent': 'Loja Grupo Oplin (sac@oplin.com.br)',
    },
    body: JSON.stringify({
      from: { postal_code: so(params.cepOrigem) },
      to: { postal_code: so(params.cepDestino) },
      products: params.itens.map((i) => ({
        id: i.id,
        width: Math.max(1, Math.ceil(i.largura)),
        height: Math.max(1, Math.ceil(i.altura)),
        length: Math.max(1, Math.ceil(i.comprimento)),
        weight: Math.max(0.01, Number(i.pesoKg.toFixed(3))),
        insurance_value: Number((i.valorCents / 100).toFixed(2)),
        quantity: i.quantidade,
      })),
      options: { receipt: false, own_hand: false },
    }),
  });
  const texto = await res.text();
  if (!res.ok) throw new Error(`Melhor Envio respondeu ${res.status}: ${texto.slice(0, 160)}`);
  let lista: Array<{
    id: number;
    name: string;
    price?: string;
    custom_price?: string;
    delivery_time?: number;
    custom_delivery_time?: number;
    error?: string;
    company?: { name?: string };
  }>;
  try {
    lista = JSON.parse(texto);
  } catch {
    throw new Error('Melhor Envio: resposta ilegível');
  }
  if (!Array.isArray(lista)) return [];
  return lista
    .filter((s) => !s.error && (s.custom_price ?? s.price))
    .map((s) => {
      const preco = Number(s.custom_price ?? s.price);
      const prazo = s.custom_delivery_time ?? s.delivery_time ?? null;
      const empresa = s.company?.name ? `${s.company.name} ` : '';
      return {
        servicoId: s.id,
        amountCents: Math.round(preco * 100),
        prazoDias: prazo,
        label: `${empresa}${s.name}${prazo ? ` — até ${prazo} dias úteis` : ''}`,
      };
    })
    .filter((o) => o.amountCents > 0)
    .sort((a, b) => a.amountCents - b.amountCents)
    .slice(0, 5);
}
