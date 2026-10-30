import { pluginResponse } from "@/src/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
type Context = { params: Promise<{ path?: string[] }> };
async function handle(req: Request, ctx: Context) { return pluginResponse(req, (await ctx.params).path); }
export { handle as GET, handle as POST, handle as PUT };
