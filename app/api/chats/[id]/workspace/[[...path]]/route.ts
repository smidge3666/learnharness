import { workspaceResponse } from "@/src/server";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
type Context = { params: Promise<{ id: string; path?: string[] }> };
async function handle(req: Request, ctx: Context) { const p = await ctx.params; return workspaceResponse(req, p.id, p.path); }
export { handle as GET, handle as POST };
