-- Défense en profondeur (audit de sécurité) : un nom ne peut pas contenir de balise HTML (< ou >).
-- Les écrans échappent déjà le texte ; ceci empêche en plus d'enregistrer un nom piégé. NOT VALID : les noms existants ne sont pas revérifiés.
alter table public.profiles drop constraint if exists profiles_full_name_no_html;
alter table public.profiles add constraint profiles_full_name_no_html check (full_name !~ '[<>]') not valid;
