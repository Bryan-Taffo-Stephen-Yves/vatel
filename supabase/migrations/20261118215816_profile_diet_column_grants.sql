-- Les colonnes de profils sont lisibles colonne par colonne : allergies, régime et allergies graves doivent l'être aussi.
grant select (allergies, diets, severe_allergies) on public.profiles to authenticated;
