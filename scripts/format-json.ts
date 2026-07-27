import { format, type Options } from "npm:prettier@3.9.6/standalone";
import babel from "npm:prettier@3.9.6/plugins/babel";
import estree from "npm:prettier@3.9.6/plugins/estree";

const EXCLUDED_DIRECTORIES = new Set([".git", ".uldren", "node_modules", "target"]);

class JsonFormatter {
  readonly #options: Options;

  constructor(options: Options) {
    this.#options = options;
  }

  async run(mode: string): Promise<void> {
    if (mode !== "write" && mode !== "check") {
      throw new Error("expected write or check mode");
    }

    const paths = await this.#jsonPaths(".");
    const unformatted: string[] = [];

    for (const path of paths) {
      const source = await Deno.readTextFile(path);
      const formatted = await format(source, {
        ...this.#options,
        filepath: path,
        parser: "json",
        plugins: [babel, estree],
      });
      if (source === formatted) {
        continue;
      }
      if (mode === "write") {
        await Deno.writeTextFile(path, formatted);
      } else {
        unformatted.push(path);
      }
    }

    if (unformatted.length > 0) {
      for (const path of unformatted) {
        console.error(path);
      }
      Deno.exit(1);
    }
  }

  async #jsonPaths(directory: string): Promise<string[]> {
    const paths: string[] = [];
    for await (const entry of Deno.readDir(directory)) {
      const path = directory === "." ? entry.name : `${directory}/${entry.name}`;
      if (entry.isDirectory && !EXCLUDED_DIRECTORIES.has(entry.name)) {
        paths.push(...await this.#jsonPaths(path));
      } else if (entry.isFile && entry.name.endsWith(".json")) {
        paths.push(path);
      }
    }
    return paths.sort();
  }
}

const options = JSON.parse(await Deno.readTextFile(".prettierrc.json")) as Options;
await new JsonFormatter(options).run(Deno.args[0] ?? "");
