-- 0009_rls-e-papeis: reverte.
DROP POLICY store_members_delete ON store_members;
DROP POLICY store_members_update ON store_members;
DROP POLICY store_members_write ON store_members;
DROP POLICY store_members_select ON store_members;
ALTER TABLE store_members NO FORCE ROW LEVEL SECURITY;
ALTER TABLE store_members DISABLE ROW LEVEL SECURITY;

DROP POLICY stores_update ON stores;
DROP POLICY stores_insert ON stores;
DROP POLICY stores_select ON stores;
ALTER TABLE stores NO FORCE ROW LEVEL SECURITY;
ALTER TABLE stores DISABLE ROW LEVEL SECURITY;

DROP POLICY store_isolation ON whatsapp_sessions;
ALTER TABLE whatsapp_sessions NO FORCE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_sessions DISABLE ROW LEVEL SECURITY;

DROP POLICY store_isolation ON settlement_items;
ALTER TABLE settlement_items NO FORCE ROW LEVEL SECURITY;
ALTER TABLE settlement_items DISABLE ROW LEVEL SECURITY;

DROP POLICY store_isolation ON settlements;
ALTER TABLE settlements NO FORCE ROW LEVEL SECURITY;
ALTER TABLE settlements DISABLE ROW LEVEL SECURITY;

DROP POLICY store_isolation ON bids;
ALTER TABLE bids NO FORCE ROW LEVEL SECURITY;
ALTER TABLE bids DISABLE ROW LEVEL SECURITY;

DROP POLICY store_isolation ON auctions;
ALTER TABLE auctions NO FORCE ROW LEVEL SECURITY;
ALTER TABLE auctions DISABLE ROW LEVEL SECURITY;

DROP POLICY store_isolation ON cards_inventory;
ALTER TABLE cards_inventory NO FORCE ROW LEVEL SECURITY;
ALTER TABLE cards_inventory DISABLE ROW LEVEL SECURITY;

DROP POLICY store_isolation ON customers;
ALTER TABLE customers NO FORCE ROW LEVEL SECURITY;
ALTER TABLE customers DISABLE ROW LEVEL SECURITY;

DROP FUNCTION app_is_platform_admin();
DROP FUNCTION app_current_user();
DROP FUNCTION app_current_store();

-- Remove os privilégios deste banco e o grupo. Os usuários LOGIN que eram
-- membros continuam existindo, só perdem a associação.
DROP OWNED BY app_runtime;
DROP ROLE app_runtime;
