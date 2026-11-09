import type { D1Database } from '@cloudflare/workers-types';
import type {
  PaymentProvider,
  CreateCheckoutParams,
  CheckoutResult,
  WebhookResult,
} from './provider';
import {
  createPendingPayment,
  getPendingByHash,
  pendingToPaidOrder,
} from './lightning/pending';

/**
 * InfinitePay — checkout integrado (Pix sem taxa e cartão em até 12x).
 *
 * Fluxo: criamos o link com POST /links (sem autenticação; a conta que recebe é
 * o `handle`, a InfiniteTag). O cliente paga na página da InfinitePay e volta
 * para o nosso pedido. A InfinitePay avisa o pagamento por webhook, mas o aviso
 * NÃO tem assinatura — então ele é só um empurrão: a autoridade é a consulta
 * POST /payment_check, feita por nós com os identificadores do aviso. Pedido só
 * vira pago quando essa consulta diz `paid: true` e o valor pago cobre o total.
 *
 * O carrinho fica guardado em pending_payments com a chave = order_nsu (o id
 * público do pedido), porque o aviso não devolve o carrinho.
 */
const API = 'https://api.checkout.infinitepay.io';
export const INFINITEPAY_CHECKOUT_TTL_SECONDS = 60 * 60;

interface LinkItem {
  quantity: number;
  price: number;
  description: string;
}

function onlyDigits(v: string | null | undefined): string {
  return String(v ?? '').replace(/\D+/g, '');
}

/** InfinitePay quer o telefone no formato +55DDDNÚMERO. */
export function phoneE164(raw: string | null | undefined): string | null {
  const d = onlyDigits(raw);
  if (d.length === 0) return null;
  if (d.startsWith('55') && (d.length === 12 || d.length === 13)) return `+${d}`;
  if (d.length === 10 || d.length === 11) return `+55${d}`;
  return null;
}

export function createInfinitePayProvider(db: D1Database, handle: string): PaymentProvider {
  const tag = handle.replace(/^\$/, '').trim();

  return {
    async createCheckout(params: CreateCheckoutParams): Promise<CheckoutResult> {
      const currency = params.lineItems[0]?.currency ?? 'brl';
      const shippingCents = params.selectedShipping?.amountCents ?? 0;
      const totalCents =
        params.lineItems.reduce((s, l) => s + l.amountCents * l.quantity, 0) + shippingCents;
      const origin = new URL(params.successUrl).origin;
      const publicId = params.metadata?.public_id ?? crypto.randomUUID();

      const items: LinkItem[] = params.lineItems.map((l) => ({
        quantity: l.quantity,
        price: l.amountCents,
        description: l.name.slice(0, 120),
      }));
      if (shippingCents > 0) {
        items.push({
          quantity: 1,
          price: shippingCents,
          description: `Frete — ${params.selectedShipping?.label ?? 'entrega'}`.slice(0, 120),
        });
      }

      const sel = params.selectedShipping;
      const addr = sel?.address as (Record<string, string | null> | undefined);
      const body: Record<string, unknown> = {
        handle: tag,
        order_nsu: publicId,
        redirect_url: params.successUrl,
        webhook_url: `${origin}/api/webhook/infinitepay`,
        items,
      };
      if (sel) {
        const customer: Record<string, string> = {};
        if (addr?.name) customer.name = addr.name;
        if (sel.email) customer.email = sel.email;
        const phone = phoneE164(addr?.phone);
        if (phone) customer.phone_number = phone;
        if (Object.keys(customer).length) body.customer = customer;
        const cep = onlyDigits(addr?.postal);
        if (cep.length === 8) {
          body.address = {
            cep,
            number: String(addr?.number ?? '').slice(0, 20),
            complement: String(addr?.line2 ?? '').slice(0, 60),
          };
        }
      }

      const res = await fetch(`${API}/links`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`InfinitePay recusou o link: ${res.status} ${text.slice(0, 200)}`);
      let url: string | undefined;
      try {
        url = (JSON.parse(text) as { url?: string }).url;
      } catch {
        url = undefined;
      }
      if (!url) throw new Error('InfinitePay: resposta sem link de pagamento');

      await createPendingPayment(db, {
        publicId,
        paymentHash: publicId,
        backend: 'infinitepay',
        bolt11: null,
        amountSat: null,
        amountTotalCents: totalCents,
        currency,
        email: sel?.email ?? null,
        itemsJson: params.orderItemsJson ?? null,
        shippingCents,
        shippingLabel: sel?.label ?? null,
        shippingWeightGrams: sel?.weightGrams ?? null,
        deliveryMethod: sel?.deliveryMethod ?? null,
        shipAddressJson: sel ? JSON.stringify(sel.address) : null,
        reservationId: params.metadata?.reservation_id ?? null,
        expiresAt: null,
      });

      return { url };
    },

    async verifyWebhook(payload: string): Promise<WebhookResult> {
      let hook: Record<string, unknown>;
      try {
        hook = JSON.parse(payload) as Record<string, unknown>;
      } catch {
        throw new Error('InfinitePay: aviso inválido');
      }
      const orderNsu = String(hook.order_nsu ?? '');
      const transactionNsu = String(hook.transaction_nsu ?? '');
      const slug = String(hook.invoice_slug ?? hook.slug ?? '');
      if (!orderNsu || !transactionNsu || !slug) throw new Error('InfinitePay: aviso incompleto');

      const pending = await getPendingByHash(db, orderNsu);
      if (!pending) return { type: 'infinitepay.unknown' };

      // A autoridade é a consulta, nunca o aviso.
      const res = await fetch(`${API}/payment_check`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          handle: tag,
          order_nsu: orderNsu,
          transaction_nsu: transactionNsu,
          slug,
        }),
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`InfinitePay: consulta falhou ${res.status}`);
      let check: { success?: boolean; paid?: boolean; amount?: number; paid_amount?: number };
      try {
        check = JSON.parse(text);
      } catch {
        throw new Error('InfinitePay: consulta ilegível');
      }
      if (!check.paid) return { type: 'infinitepay.not_paid' };
      const paidCents = Number(check.paid_amount ?? check.amount ?? 0);
      if (!(paidCents >= pending.amount_total_cents)) {
        throw new Error('InfinitePay: valor pago menor que o total do pedido');
      }
      return {
        type: 'infinitepay.paid',
        settlePendingPaymentId: orderNsu,
        order: pendingToPaidOrder(pending),
      };
    },
    // Sem reembolso por API: estorno é feito no app da InfinitePay.
  };
}
