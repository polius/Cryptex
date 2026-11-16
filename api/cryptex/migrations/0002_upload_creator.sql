-- B1: who started an unfinished upload (an account ID, or an address as rate limits count it: ip:… or ip6:…/64), so
-- one caller can't reserve the whole disk with uploads it never sends. Cleared at seal: a sealed secret keeps no address.
ALTER TABLE secrets ADD COLUMN creator TEXT;
CREATE INDEX secrets_unsealed_creator ON secrets(creator) WHERE sealed = 0;
