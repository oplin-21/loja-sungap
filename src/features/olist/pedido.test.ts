import { describe, expect, it } from 'vitest';
import { dataBrasil, montarPedido, type DadosPedido } from './pedido';

const base: DadosPedido = {
  referencia: '7y3jpd6p2q',
  criadoEm: '2026-11-10 01:30:00', // 22:30 de 09/11 em Brasília
  email: 'cliente@exemplo.com',
  endereco: {
    name: 'Empresa Exemplo Ltda',
    line1: 'Rua das Flores',
    number: '120',
    line2: 'Sala 3',
    district: 'Centro',
    city: 'São Paulo',
    state: 'SP',
    postal: '01001-000',
    document: '11.222.333/0001-81',
    phone: '(11) 98888-7777',
  },
  itens: [
    { nome: 'Ombrelone 3m - Bege', precoCents: 189990, quantidade: 2, olistId: '901', sku: 'OMB3-BG' },
    { nome: 'Item avulso', precoCents: 300, quantidade: 1, olistId: null, sku: null },
  ],
  freteCents: 4590,
  freteNome: 'Correios SEDEX — até 3 dias úteis',
  descontoCents: 0,
  meioPagamento: 'InfinitePay',
  idEcommerce: '54851',
  nomeLoja: 'Sungap',
};

describe('montarPedido', () => {
  it('monta cliente PJ, itens, frete e vínculo com a integração', () => {
    const { pedido } = montarPedido(base) as { pedido: Record<string, any> };
    expect(pedido.data_pedido).toBe('09/11/2026');
    expect(pedido.numero_pedido_ecommerce).toBe('7y3jpd6p2q');
    expect(pedido.situacao).toBe('aprovado');
    expect(pedido.id_ecommerce).toBe(54851);
    expect(pedido.cliente).toMatchObject({ tipo_pessoa: 'J', cpf_cnpj: '11222333000181', cep: '01001000', fone: '11988887777', uf: 'SP', numero: '120', bairro: 'Centro' });
    expect(pedido.itens[0].item).toMatchObject({ id_produto: '901', codigo: 'OMB3-BG', quantidade: '2', valor_unitario: '1899.90', unidade: 'UN' });
    expect(pedido.itens[1].item.id_produto).toBeUndefined();
    expect(pedido.valor_frete).toBe('45.90');
    expect(pedido.endereco_entrega.nome_destinatario).toBe('Empresa Exemplo Ltda');
  });
  it('pessoa física pelo CPF e sem vínculo quando pedido', () => {
    const { pedido } = montarPedido({ ...base, endereco: { ...base.endereco, document: '529.982.247-25' } }, false) as { pedido: Record<string, any> };
    expect(pedido.cliente.tipo_pessoa).toBe('F');
    expect(pedido.id_ecommerce).toBeUndefined();
  });
  it('data no fuso de Brasília', () => {
    expect(dataBrasil('2026-11-09 12:00:00')).toBe('09/11/2026');
  });
});
