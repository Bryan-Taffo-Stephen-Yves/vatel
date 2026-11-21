-- Alerte « solde bas » (élève + parent) dès que le solde passe sous 15 000 FCFA (environ 6 repas)
update public.settings set value = '15000'::jsonb where key = 'low_balance_threshold';
