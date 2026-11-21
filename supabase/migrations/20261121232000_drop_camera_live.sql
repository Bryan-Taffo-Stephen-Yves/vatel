-- Nettoyage : la caméra pilotée depuis le PC existe déjà dans vatel (vision_setup, 20261121220000).
-- La migration 20261121132641_camera_live (dépôt dabali, appliquée en ligne par erreur de dépôt) l'avait doublée :
-- table camera_settings (restée vide) et fonctions camera_config / camera_save_zones, utilisées par aucun écran de vatel.
-- « if exists » : sans effet sur une base neuve (où camera_live n'a jamais existé).
drop function if exists public.camera_save_zones(jsonb);
drop function if exists public.camera_config();
drop table if exists public.camera_settings;
