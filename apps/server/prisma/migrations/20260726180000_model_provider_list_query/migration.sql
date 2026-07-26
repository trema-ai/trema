-- A provider's model listing can hide part of its catalog behind a query
-- filter: OpenRouter's `/models` omits embedding models unless the call asks
-- for every output modality. That is a vendor fact, so it rides with the row a
-- preset seeds rather than becoming a branch in the protocol's listing code.

-- AlterTable
ALTER TABLE "ModelProvider" ADD COLUMN     "listQueryJson" JSONB;
