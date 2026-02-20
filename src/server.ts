import { join } from "path";
import { loadChecks } from "./checks";
import { runAnnotation } from "./ai";

interface ServerOptions {
  filePath: string;
  projectRoot: string;
  apiKey: string;
}

export function startServer(options: ServerOptions): { url: string; stop: () => void } {
  const { filePath, projectRoot, apiKey } = options;
  const uiDir = join(import.meta.dir, "ui");

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);

      // Static UI files
      if (url.pathname === "/" || url.pathname === "/index.html") {
        return new Response(Bun.file(join(uiDir, "index.html")), {
          headers: { "Content-Type": "text/html" },
        });
      }
      if (url.pathname === "/styles.css") {
        return new Response(Bun.file(join(uiDir, "styles.css")), {
          headers: { "Content-Type": "text/css" },
        });
      }
      if (url.pathname === "/app.js") {
        return new Response(Bun.file(join(uiDir, "app.js")), {
          headers: { "Content-Type": "application/javascript" },
        });
      }

      // API: get original file content
      if (url.pathname === "/api/file" && req.method === "GET") {
        const content = await Bun.file(filePath).text();
        return Response.json({ content, filePath });
      }

      // API: get available checks (reloaded fresh each time)
      if (url.pathname === "/api/checks" && req.method === "GET") {
        const checks = await loadChecks(projectRoot);
        const list = Object.values(checks).map((c) => ({
          name: c.name,
          prompt: c.prompt,
        }));
        return Response.json(list);
      }

      // API: run annotation (reloads checks to pick up edits)
      if (url.pathname === "/api/annotate" && req.method === "POST") {
        try {
          const checks = await loadChecks(projectRoot);
          const body = await req.json() as { markdown: string; checkName: string; model?: string };
          const check = checks[body.checkName];
          if (!check) {
            return Response.json({ error: `Unknown check: ${body.checkName}` }, { status: 400 });
          }
          console.log(`Running check "${body.checkName}" with ${body.model ?? "default model"}...`);
          const annotated = await runAnnotation(body.markdown, check, apiKey, body.model);
          console.log(`Check "${body.checkName}" complete.`);
          return Response.json({ annotated });
        } catch (err: any) {
          console.error("Annotation error:", err);
          return Response.json({ error: err.message ?? "AI request failed" }, { status: 500 });
        }
      }

      // API: save file
      if (url.pathname === "/api/save" && req.method === "POST") {
        try {
          const body = await req.json() as { markdown: string };
          await Bun.write(filePath, body.markdown);
          console.log(`Saved to ${filePath}`);
          return Response.json({ ok: true });
        } catch (err: any) {
          console.error("Save error:", err);
          return Response.json({ error: err.message ?? "Save failed" }, { status: 500 });
        }
      }

      return new Response("Not found", { status: 404 });
    },
  });

  const url = `http://localhost:${server.port}`;
  return { url, stop: () => server.stop() };
}
