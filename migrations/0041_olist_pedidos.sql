-- 0041: pedido pago da loja → pedido de venda no Olist (modelo Nuvemshop) e
-- recebimento dos produtos que o Olist envia para a loja.

-- Estado do envio de cada pedido ao Olist. NULL = aguardando envio.
ALTER TABLE orders ADD COLUMN olist_estado TEXT;        -- NULL | enviando | ok | erro | fora
ALTER TABLE orders ADD COLUMN olist_pedido_id TEXT;     -- id do pedido no Olist
ALTER TABLE orders ADD COLUMN olist_pedido_numero TEXT; -- número do pedido no Olist
ALTER TABLE orders ADD COLUMN olist_tentativas INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN olist_tentado_em TEXT;
ALTER TABLE orders ADD COLUMN olist_erro TEXT;

-- Pedidos que já existiam antes desta versão não sobem.
UPDATE orders SET olist_estado = 'fora';

-- Produto que o Olist enviou para a loja fica na loja mesmo sem bater a marca.
ALTER TABLE olist_fila ADD COLUMN origem TEXT; -- 'aviso' = enviado pelo Olist

-- Avisos que o Olist manda para a loja (produto enviado, estoque, preço).
-- Guarda o corpo bruto para conferência; os 200 mais recentes ficam.
CREATE TABLE IF NOT EXISTS olist_avisos (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  evento    TEXT NOT NULL,
  corpo     TEXT NOT NULL,
  ids       TEXT,
  recebido  TEXT NOT NULL DEFAULT (datetime('now'))
);
