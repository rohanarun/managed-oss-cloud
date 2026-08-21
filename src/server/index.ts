import { createApp } from "./app.js";
import { config } from "./config.js";

const app = await createApp();
app.listen(config.PORT, () => {
  process.stdout.write(`${config.PRODUCT_NAME} control plane listening on ${config.PORT}\n`);
});
