import { stageMiraeSifMetadataReviews } from "../apps/ingestion/src/metadata-review/stage.ts";

const staged = await stageMiraeSifMetadataReviews();
console.log(JSON.stringify({ staged }, null, 2));
