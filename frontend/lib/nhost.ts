import { createClient } from "@nhost/nhost-js";

export const nhost = createClient({
  subdomain:
    process.env.NEXT_PUBLIC_NHOST_SUBDOMAIN || "lxurpouvxelcvrbqpbxk",
  region:
    process.env.NEXT_PUBLIC_NHOST_REGION || "eu-central-1",
});
