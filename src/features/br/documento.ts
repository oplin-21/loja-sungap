/**
 * Validações brasileiras puras (sem Cloudflare): CPF, CNPJ, CEP, UF e telefone.
 * Ficam fora das rotas para poderem ser testadas e reaproveitadas pelas outras
 * lojas do grupo.
 */

export const UFS = [
  'AC', 'AL', 'AP', 'AM', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MT', 'MS', 'MG', 'PA',
  'PB', 'PR', 'PE', 'PI', 'RJ', 'RN', 'RS', 'RO', 'RR', 'SC', 'SP', 'SE', 'TO',
] as const;

export const digits = (v: string | null | undefined): string => String(v ?? '').replace(/\D+/g, '');

export function cpfValido(raw: string): boolean {
  const c = digits(raw);
  if (c.length !== 11 || /^(\d)\1{10}$/.test(c)) return false;
  for (const n of [9, 10]) {
    let soma = 0;
    for (let i = 0; i < n; i++) soma += Number(c[i]) * (n + 1 - i);
    const dv = ((soma * 10) % 11) % 10;
    if (dv !== Number(c[n])) return false;
  }
  return true;
}

export function cnpjValido(raw: string): boolean {
  const c = digits(raw);
  if (c.length !== 14 || /^(\d)\1{13}$/.test(c)) return false;
  const calc = (len: number) => {
    const pesos = len === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    const soma = pesos.reduce((s, p, i) => s + Number(c[i]) * p, 0);
    const r = soma % 11;
    return r < 2 ? 0 : 11 - r;
  };
  return calc(12) === Number(c[12]) && calc(13) === Number(c[13]);
}

/** CPF (11 dígitos) ou CNPJ (14 dígitos) com dígito verificador correto. */
export function documentoValido(raw: string): boolean {
  const d = digits(raw);
  return d.length === 11 ? cpfValido(d) : d.length === 14 ? cnpjValido(d) : false;
}

export function formataDocumento(raw: string): string {
  const d = digits(raw);
  if (d.length === 11) return d.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
  if (d.length === 14) return d.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5');
  return raw;
}

export const cepValido = (raw: string): boolean => digits(raw).length === 8;
export const formataCep = (raw: string): string => digits(raw).replace(/(\d{5})(\d{3})/, '$1-$2');

/** Celular ou fixo com DDD: 10 ou 11 dígitos (com ou sem o 55 na frente). */
export function telefoneValido(raw: string): boolean {
  let d = digits(raw);
  if (d.startsWith('55') && (d.length === 12 || d.length === 13)) d = d.slice(2);
  return d.length === 10 || d.length === 11;
}

export const ufValida = (raw: string): boolean => (UFS as readonly string[]).includes(raw.toUpperCase());
