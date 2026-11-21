-- L'appli prend le nom de l'école : « Vatel ». Nom de la cantine affiché dans le suivi des livraisons.
update public.settings set value = jsonb_set(value, '{canteen,name}', '"Cantine Vatel"')
 where key = 'delivery' and value #>> '{canteen,name}' = 'Cantine Dabali';
