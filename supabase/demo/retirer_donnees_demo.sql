-- Retire les données de DÉMONSTRATION créées pour le jury (21/11/2026) : tout ce qui est noté dans public.demo_seed.
-- À coller dans l'éditeur SQL de Supabase APRÈS le jury. Les soldes sont remis comme avant (mouvements simulés annulés).
-- Les quantités servies / préparées des menus du 9 au 20 novembre restent (elles ne touchent ni l'argent ni les comptes).
begin;
set local session_replication_role = replica;   -- pas de notification pendant le nettoyage
update wallets w set balance = w.balance - x.s
  from (select t.user_id, sum(t.amount) s from transactions t join demo_seed d on d.tbl = 'transactions' and d.id = t.id group by 1) x
 where w.user_id = x.user_id;
delete from ratings      where id in (select id from demo_seed where tbl = 'ratings');
delete from plate_scans  where id in (select id from demo_seed where tbl = 'plate_scans');
delete from staff_meals  where id in (select id from demo_seed where tbl = 'staff_meals');
delete from transactions where id in (select id from demo_seed where tbl = 'transactions');
delete from guest_vouchers where ticket_id in (select id from demo_seed where tbl = 'tickets');
delete from ratings      where ticket_id in (select id from demo_seed where tbl = 'tickets');
delete from plate_scans  where ticket_id in (select id from demo_seed where tbl = 'tickets');
delete from tickets      where id in (select id from demo_seed where tbl = 'tickets');
delete from guest_events where id in (select id from demo_seed where tbl = 'guest_events');
delete from shopping_items where list_id in (select id from demo_seed where tbl = 'shopping_lists');
delete from shopping_lists where id in (select id from demo_seed where tbl = 'shopping_lists');
drop table public.demo_seed;
select count(*) as soldes_incoherents from wallets w
 where w.balance <> (select coalesce(sum(amount), 0) from transactions t where t.user_id = w.user_id);
commit;
