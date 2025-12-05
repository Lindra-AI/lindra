import { mkdirSync, rmSync, writeFileSync } from "fs";
import path from "path";
import { ZodError } from "zod";
import { GoogleGenAI } from "@google/genai";
import { BrowserController } from "./controller.js";
import {
  type ActionRegistry,
  defaultActions,
  executeAction,
} from "./actions.js";
import {
  type Task,
  type Ai,
  createAi,
  ACTION_KEY,
  type ActionCall,
  type HistoryItem,
} from "./ai.js";
import { type BrowserProvider, LocalProvider } from "./providers.js";

interface Config {
  maxIterations: number | null;
  dirPath: string;
  outputToDir: boolean;
  device: {
    width: number;
    height: number;
  };
  provider: BrowserProvider;
  actionRegistry: ActionRegistry;
  ai: Ai;
  debug: {
    iterations: boolean;
    decisionScreenshots: boolean;
  };
}

const defaultConfig: Config = {
  maxIterations: null,
  dirPath: ".lindra",
  outputToDir: true,
  device: {
    width: 1920,
    height: 1080,
  },
  provider: new LocalProvider(),
  actionRegistry: defaultActions,
  ai: createAi(new GoogleGenAI({})),
  debug: {
    iterations: true,
    decisionScreenshots: true,
  },
};

interface Output<T> {
  json: T;
  csv: Record<string, string[][]>;
}

const getTabsData = async (controller: BrowserController) => {
  return await Promise.all(
    controller.getTabIds().map(async (id) => {
      const tab = controller.getTab(id);
      return {
        id,
        isLoading: !tab.isReady(),
        url: tab.getUrl(),
        title: await tab.getTitle(),
      };
    }),
  );
};

const loop = async <T>(
  task: Task<T>,
  config: Config,
  initialTabId: number,
  controller: BrowserController,
): Promise<{ error: string } | { output: Output<T> }> => {
  let iter = 0;
  let activeTabId = initialTabId;
  const memories: Record<string, string> = {};
  const dataForJson: string[] = [];
  const csv: Record<string, string[][]> = Object.fromEntries(
    Object.keys(task.csvOutputSchemas).map((name) => [name, []]),
  );
  const history: HistoryItem[] = [];
  let viewportDescriptions: string = "";

  while (true) {
    if (config.maxIterations !== null && iter >= config.maxIterations) {
      return { error: "Max iterations reached" };
    }

    const activeTab = controller.getTab(activeTabId);
    await new Promise((r) => setTimeout(r, 500));
    await activeTab.init(false);

    const screenshot = await activeTab.screenshot();
    const scrollData = await activeTab.getScrollData();
    const snapshot = await activeTab.snapshot();
    const state = {
      tabs: await getTabsData(controller),
      activeTab: {
        id: activeTabId,
        totalHeight: scrollData.totalHeight,
        scrollPosition: scrollData.scrollPosition,
        screenshot,
        width: config.device.width,
        height: config.device.height,
        snapshot,
      },
    };

    if (config.debug.decisionScreenshots) {
      writeFileSync(
        path.join(config.dirPath, `debug/${iter}.png`),
        Buffer.from(state.activeTab.screenshot, "base64"),
      );
    }

    const decision = await config.ai.decide(
      task,
      state,
      history,
      viewportDescriptions,
      memories,
      config.actionRegistry,
    );

    if (decision.success === true || decision.success === null) {
      dataForJson.push(decision.dataForJson);
      for (const [name, rows] of Object.entries(decision.csv)) {
        if (name in csv) csv[name] = csv[name]!.concat(rows);
      }
    }

    if (decision.success === true) {
      return {
        output: {
          json: await config.ai.formatJsonOutput(
            task.instructions,
            decision.summary,
            dataForJson,
            task.jsonOutputSchema,
          ),
          csv,
        },
      };
    } else if (decision.success === false) {
      return { error: decision.reasoningForDecision };
    } else {
      if (decision.actions.length === 0) throw new Error("No action to take");

      const ctx = {
        secrets: task.secrets,
        width: config.device.width,
        height: config.device.height,
        activeTab: activeTab,
        switchToTab: async (tabId: number, closeActiveTab: boolean) => {
          if (controller.getTabIds().includes(tabId)) {
            if (closeActiveTab) await controller.closeTab(activeTabId);
            activeTabId = tabId;
            return true;
          } else return false;
        },
        snapshot: state.activeTab.snapshot,
      };

      const actionResults: string[] = [];
      const executedActions: ActionCall[] = [];

      for (const action of decision.actions as ActionCall[]) {
        const { [ACTION_KEY]: actionName, ...actionArgs } = action;

        let result: string;
        try {
          result = await executeAction(
            config.actionRegistry,
            actionName,
            actionArgs,
            ctx,
          );
        } catch (error) {
          if (error instanceof ZodError) {
            result = `Invalid action arguments: ${error.message}`;
          } else throw error;
        }

        actionResults.push(result);
        executedActions.push(action);

        if (
          result.toLowerCase().startsWith("error") ||
          result.toLowerCase().startsWith("invalid")
        ) {
          break;
        }
      }

      const actionResult = actionResults.join("\n");

      for (const [name, memory] of Object.entries(decision.newMemories)) {
        if (memory.length > 0) memories[name] = memory;
        else if (name in memories) delete memories[name];
      }

      const {
        reasoningForDecision,
        viewportDescriptions: newViewportDescriptions,
      } = decision;
      viewportDescriptions = newViewportDescriptions;
      const historyItem: HistoryItem = {
        info: { reasoningForDecision },
        actions: executedActions,
        actionResult,
      };
      history.push(historyItem);

      if (config.debug.iterations) {
        writeFileSync(
          path.join(config.dirPath, `debug/${iter}.json`),
          JSON.stringify(
            {
              historyItem,
              viewportDescriptions,
              newMemories: decision.newMemories,
              dataForJson: decision.dataForJson,
              csv: decision.csv,
            },
            null,
            2,
          ),
        );
      }
    }

    iter++;
  }
};

const main = async <T>(
  task: Task<T>,
  config: Config,
): Promise<{ error?: string; output?: Output<T> }> => {
  rmSync(config.dirPath, { recursive: true, force: true });
  mkdirSync(config.dirPath);
  mkdirSync(path.join(config.dirPath, "debug"));
  if (config.outputToDir) {
    mkdirSync(path.join(config.dirPath, "output"));
  }

  const controller = new BrowserController(
    config.device.width,
    config.device.height,
  );
  await controller.init(config.provider);

  const initialTabId = controller.getTabIds()[0]!;
  await controller.getTab(initialTabId).navigate(task.initialURL);

  const result = await loop(task, config, initialTabId, controller);

  await controller.destroy();
  if (config.outputToDir) {
    if ("error" in result) return result;

    writeFileSync(
      path.join(config.dirPath, "output/output.json"),
      JSON.stringify(result.output.json, null, 2),
    );
    for (const [name, rows] of Object.entries(result.output.csv)) {
      writeFileSync(
        path.join(config.dirPath, `output/${name}.csv`),
        [task.csvOutputSchemas[name], ...rows]
          .map((row) => row!.map((cell) => `"${cell}"`).join(","))
          .join("\n"),
      );
    }
    return {};
  } else return result;
};

export { type Config, defaultConfig };
export default main;
