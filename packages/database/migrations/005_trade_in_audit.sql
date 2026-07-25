-- Tie each trade-in audit to the consumed inventory item and its source event.
ALTER TABLE trade_ins
ADD COLUMN inventory_id UUID REFERENCES inventory(id),
ADD COLUMN source_event_id TEXT;

CREATE UNIQUE INDEX trade_ins_inventory_unique_idx
ON trade_ins (inventory_id)
WHERE inventory_id IS NOT NULL;

CREATE UNIQUE INDEX trade_ins_source_event_unique_idx
ON trade_ins (source_event_id)
WHERE source_event_id IS NOT NULL;

CREATE INDEX trade_ins_user_created_idx
ON trade_ins (user_id, created_at DESC);
