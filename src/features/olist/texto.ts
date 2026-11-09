/**
 * Conversões puras do Olist para a loja (sem Cloudflare, testáveis).
 */

const ENTIDADES: Record<string, string> = {
  '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'",
  '&aacute;': 'á', '&eacute;': 'é', '&iacute;': 'í', '&oacute;': 'ó', '&uacute;': 'ú',
  '&atilde;': 'ã', '&otilde;': 'õ', '&ccedil;': 'ç', '&ecirc;': 'ê', '&ocirc;': 'ô', '&agrave;': 'à',
};

/**
 * A descrição do Olist vem em HTML; a loja guarda Markdown e escapa HTML cru.
 * Mantém parágrafos, quebras e negrito; descarta o resto das tags.
 */
export function htmlParaMarkdown(html: string | null | undefined): string {
  let s = String(html ?? '');
  s = s.replace(/<\s*br\s*\/?>/gi, '\n');
  s = s.replace(/<\s*\/p\s*>/gi, '\n\n').replace(/<\s*p[^>]*>/gi, '');
  s = s.replace(/<\s*li[^>]*>/gi, '\n- ').replace(/<\s*\/li\s*>/gi, '');
  s = s.replace(/<\s*(strong|b)[^>]*>\s*/gi, '**').replace(/\s*<\s*\/(strong|b)\s*>/gi, '**');
  s = s.replace(/<[^>]+>/g, '');
  s = s.replace(/&[a-z#0-9]+;/gi, (e) => ENTIDADES[e.toLowerCase()] ?? (e.startsWith('&#') ? String.fromCharCode(Number(e.slice(2, -1)) || 32) : ' '));
  s = s.replace(/\*\*\s*\*\*/g, '');
  s = s.replace(/[ \t]+\n/g, '\n').replace(/\n[ \t]+/g, '\n').replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

export function reaisParaCentavos(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(String(v ?? '').replace(',', '.'));
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

export function numeroOuNulo(v: unknown): number | null {
  const n = Number(String(v ?? '').replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function slugify(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 90);
}

/** Rótulo da variação a partir da grade ({ Cor: 'Bege' } → 'Bege'). */
export function rotuloGrade(grade: unknown): { grupo: string | null; rotulo: string } {
  // Também chega como lista [{ chave: 'Cor', valor: 'Bege' }].
  if (Array.isArray(grade)) {
    const itens = grade.filter((g) => g && typeof g === 'object') as { chave?: unknown; valor?: unknown }[];
    if (itens.length) {
      return {
        grupo: itens.map((g) => String(g.chave ?? '')).join(' / ') || null,
        rotulo: itens.map((g) => String(g.valor ?? '')).join(' / '),
      };
    }
    return { grupo: null, rotulo: '' };
  }
  if (grade && typeof grade === 'object') {
    const entradas = Object.entries(grade as Record<string, unknown>);
    if (entradas.length > 0) {
      return {
        grupo: entradas.map(([k]) => k).join(' / '),
        rotulo: entradas.map(([, v]) => String(v)).join(' / '),
      };
    }
  }
  return { grupo: null, rotulo: '' };
}
