-- 0042: fotos das variações que o Olist manda no aviso de "Enviar para o e-commerce".
-- No Olist da Sungap as fotos ficam na variação (uma por cor), não no produto pai,
-- e a API produto.obter do pai não as devolve.
CREATE TABLE IF NOT EXISTS olist_var_imagens (
  olist_id  TEXT NOT NULL,   -- id da variação no Olist
  pos       INTEGER NOT NULL,
  url       TEXT NOT NULL,
  PRIMARY KEY (olist_id, pos)
);
