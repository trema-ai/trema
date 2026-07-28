-- The input a turn was given: steering and follow-ups drained just before its
-- model call. A resumed execution rebuilds the model context from committed
-- turns, so without this the messages a person sent mid-run were replayed as an
-- assistant answer to nothing. Existing turns default to no input, which is
-- what they recorded.
ALTER TABLE "Turn" ADD COLUMN "input" JSONB NOT NULL DEFAULT '[]';
