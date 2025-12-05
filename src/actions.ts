import { z } from "zod";
import { type Coord, type Snapshot } from "./dom.js";
import { type Tab } from "./controller.js";

interface ActionContext {
  secrets: Record<string, string>;
  width: number;
  height: number;
  activeTab: Tab;
  switchToTab: (tabId: number, closeActiveTab: boolean) => Promise<boolean>;
  snapshot: Snapshot;
}

interface Action<TArgs extends z.ZodObject<any> = z.ZodObject<any>> {
  description: string;
  args: TArgs;
  handler: (args: z.infer<TArgs>, ctx: ActionContext) => Promise<string>;
}

type ActionRegistry = Record<string, Action>;

function defineAction<T extends z.ZodObject<any>>(
  action: Action<T>,
): Action<T> {
  return action;
}

async function executeAction(
  actionRegistry: ActionRegistry,
  name: string,
  args: unknown,
  ctx: ActionContext,
): Promise<string> {
  const action = actionRegistry[name];
  if (!action) throw new Error(`Unknown action: ${name}`);
  const validatedArgs = action.args.parse(args);
  return await action.handler(validatedArgs, ctx);
}

const scaleCoord = (
  coord: Coord,
  actualWidth: number,
  actualHeight: number,
): Coord => {
  return [
    Math.round((coord[0] * actualWidth) / 1_000),
    Math.round((coord[1] * actualHeight) / 1_000),
  ];
};

const defaultActions = {
  switchToTab: defineAction({
    description: "Switch to another tab, and optionally close the active tab.",
    args: z.object({ tabId: z.number(), closeActiveTab: z.boolean() }),
    handler: async (args, ctx) => {
      const success = await ctx.switchToTab(args.tabId, args.closeActiveTab);
      return success ? "Success" : "Failure";
    },
  }),

  wait: defineAction({
    description:
      "Wait for a specified number of seconds. Use this when the page content is dynamic or takes time to load, and you need to wait before proceeding.",
    args: z.object({ seconds: z.number() }),
    handler: async (args, ctx) => {
      await ctx.activeTab.wait(args.seconds * 1_000);
      return "";
    },
  }),

  navigate: defineAction({
    description:
      "Navigate to another URL. If the provided URL is empty (empty string), go back.",
    args: z.object({ url: z.string() }),
    handler: async (args, ctx) => {
      try {
        await ctx.activeTab.navigate(args.url);
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
      return "";
    },
  }),

  reload: defineAction({
    description: "Reload the current page.",
    args: z.object({}),
    handler: async (args, ctx) => {
      await ctx.activeTab.reload();
      return "";
    },
  }),

  scroll: defineAction({
    description:
      "Scroll within a specified area of the page. If the area at the provided coordinates is not scrollable, its ancestors will be tried until a scrollable element is found. The scroll amount must be expressed as a percentage of the height of the area, for example, -150 will scroll up by 1.5 area heights. If sticky elements (such as headers or notifications) may overlap the scrollable area, consider scrolling a bit less than necessary.",
    args: z.object({
      x: z.number(),
      y: z.number(),
      vertical: z.boolean(),
      amount: z.number(),
    }),
    handler: async (args, ctx) => {
      const coord = scaleCoord([args.x, args.y], ctx.width, ctx.height);
      await ctx.activeTab.scroll(coord, args.amount / 100, args.vertical);
      return "";
    },
  }),

  click: defineAction({
    description:
      "Click at the specified coordinates, either using a regular click or opening into a new tab.",
    args: z.object({ x: z.number(), y: z.number(), newTab: z.boolean() }),
    handler: async (args, ctx) => {
      const coord = scaleCoord([args.x, args.y], ctx.width, ctx.height);
      await ctx.activeTab.click(coord, args.newTab);
      return "";
    },
  }),

  fillInput: defineAction({
    description:
      "Type text into a specified input element. The value can be either text to type (secret=false) or the key of a secret (secret=true). Optionally, press Enter after typing.",
    args: z.object({
      id: z.number(),
      secret: z.boolean(),
      value: z.string(),
      pressEnter: z.boolean(),
    }),
    handler: async (args, ctx) => {
      const coord = ctx.snapshot.inputs[args.id]!.coord;
      const text = args.secret ? ctx.secrets[args.value]! : args.value;
      await ctx.activeTab.type(coord, text, args.pressEnter);
      return "";
    },
  }),

  fillTextarea: defineAction({
    description:
      "Type text into a specified textarea element. The value can be either text to type (secret=false) or the key of a secret (secret=true).",
    args: z.object({
      id: z.number(),
      secret: z.boolean(),
      value: z.string(),
    }),
    handler: async (args, ctx) => {
      const coord = ctx.snapshot.textareas[args.id]!.coord;
      const text = args.secret ? ctx.secrets[args.value]! : args.value;
      await ctx.activeTab.type(coord, text, false);
      return "";
    },
  }),

  select: defineAction({
    description:
      "Select options from a specified dropdown menu. All other options will be deselected. Specify each option by its code value, not text content, unless the value is empty. Separate multiple options with newlines.",
    args: z.object({ id: z.number(), options: z.string() }),
    handler: async (args, ctx) => {
      await ctx.activeTab.select(
        ctx.snapshot.selects[args.id]!.coord,
        args.options.split("\n"),
      );
      return "";
    },
  }),
};

export { type ActionRegistry, defineAction, executeAction, defaultActions };
