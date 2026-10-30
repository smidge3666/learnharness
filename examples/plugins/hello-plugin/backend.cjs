"use strict";
// Node CommonJS module. Runs inside the LearnHarness server with full Node access.
exports.onload = async (api) => {
	api.handle("count", () => api.storage.read("counter") ?? { count: 0 });
	api.handle("increment", () => {
		const next = { count: (api.storage.read("counter")?.count ?? 0) + 1 };
		api.storage.write("counter", next);
		return next;
	});
	api.handle("slow-task", () => api.background("Hello wait", async (signal) => {
		await new Promise((resolve, reject) => {
			const timer = setTimeout(resolve, 2000);
			signal.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("cancelled")); }, { once: true });
		});
		return "done";
	}));
	// Uses your configured model slot and spends provider credits.
	api.handle("summarize", (input) => api.agents.run({
		role: "researcher",
		systemPrompt: "You summarize text in three bullet points.",
		prompt: String(input?.text ?? ""),
		maxTurns: 1,
	}));
	api.log("loaded");
	return () => api.log("cleanup");
};
exports.onunload = () => {};
