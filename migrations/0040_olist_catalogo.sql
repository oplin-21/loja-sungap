-- 0040: catálogo vindo do Olist ERP (somente leitura) + dados para frete e Google Merchant.
-- Aditiva: produtos cadastrados à mão continuam com estas colunas em NULL.

ALTER TABLE products ADD COLUMN olist_id TEXT;      -- id do produto (pai ou simples) no Olist
ALTER TABLE products ADD COLUMN sku TEXT;           -- código do Olist
ALTER TABLE products ADD COLUMN gtin TEXT;          -- EAN do produto simples
ALTER TABLE products ADD COLUMN brand TEXT;         -- marca (Sungap, Oia Decor…)
ALTER TABLE products ADD COLUMN length_cm REAL;     -- embalagem: comprimento
ALTER TABLE products ADD COLUMN width_cm REAL;      -- embalagem: largura
ALTER TABLE products ADD COLUMN height_cm REAL;     -- embalagem: altura
ALTER TABLE products ADD COLUMN olist_synced_at TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_products_olist ON products(olist_id) WHERE olist_id IS NOT NULL;

ALTER TABLE product_variants ADD COLUMN olist_id TEXT;
ALTER TABLE product_variants ADD COLUMN gtin TEXT;
ALTER TABLE product_variants ADD COLUMN stock_checked_at TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_variants_olist ON product_variants(olist_id) WHERE olist_id IS NOT NULL;

-- Fila de leitura do Olist: tudo o que a listagem devolveu, para a próxima etapa
-- detalhar aos poucos (o limite de chamadas é por conta e o PCP divide o mesmo teto).
CREATE TABLE IF NOT EXISTS olist_fila (
  olist_id     TEXT PRIMARY KEY,
  tipo         TEXT NOT NULL,               -- P (pai), V (variação), N (simples)
  nome         TEXT NOT NULL,
  codigo       TEXT,
  preco_cents  INTEGER NOT NULL DEFAULT 0,
  gtin         TEXT,
  estado       TEXT NOT NULL DEFAULT 'novo', -- novo | ok | ignorado | erro
  tentativas   INTEGER NOT NULL DEFAULT 0,
  atualizado   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_olist_fila_estado ON olist_fila(estado, tipo);

-- Imagem do Olist já copiada para o R2 (não baixa duas vezes).
CREATE TABLE IF NOT EXISTS olist_imagens (
  url        TEXT PRIMARY KEY,
  image_key  TEXT NOT NULL
);
