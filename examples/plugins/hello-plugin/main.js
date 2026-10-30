// Browser ES module. Runs in the app window with full page privileges.
export async function onload(api) {
	api.commands.register({
		id: "count",
		name: "Hello: count",
		run: async () => {
			const result = await api.rpc("increment");
			api.events.emit("hello-plugin:count", result.count);
		},
	});
	api.panels.register("Hello plugin", (el) => {
		const out = document.createElement("p");
		out.className = "hello-plugin-out";
		const refresh = async () => { out.textContent = "Count: " + (await api.rpc("count")).count; };
		const off = api.events.on("hello-plugin:count", (count) => { out.textContent = "Count: " + count; });
		const work = document.createElement("button");
		work.textContent = "Run background task";
		work.onclick = async () => { out.textContent = "Task " + (await api.rpc("slow-task")); };
		el.append(out, work);
		void refresh();
		return off;
	});
}

export function onunload() {}
