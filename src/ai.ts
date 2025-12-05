import { z } from "zod";
import { type GoogleGenAI, ThinkingLevel, type Part } from "@google/genai";
import { type ActionRegistry } from "./actions.js";
import { type Coord, type Snapshot } from "./dom.js";

interface Task<T = unknown> {
  initialURL: string;
  instructions: string;
  secrets: Record<string, string>;
  jsonOutputSchema: z.ZodType<T>;
  csvOutputSchemas: Record<string, string[]>;
}

const createImagePart = (data: string, mimeType: string): Part => {
  return { inlineData: { data, mimeType } };
};

const generateText = async <T = object>(
  genAI: GoogleGenAI,
  contents: (string | Part)[],
  schema: z.ZodSchema<T>,
  temperature: number = 1,
  maxAttempts: number = 10,
  attemptInterval: number = 5_000,
): Promise<T> => {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const result = await genAI.models.generateContent({
        model: "gemini-3-pro-preview",
        contents,
        config: {
          temperature,
          thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
          maxOutputTokens: 64_000,
          responseMimeType: "application/json",
          responseSchema: z.toJSONSchema(schema),
        },
      });

      if (result.text === undefined) {
        throw new Error("No response from Gemini");
      }

      try {
        return JSON.parse(result.text) as T;
      } catch (error) {
        throw new Error(`Invalid JSON result from Gemini: ${result.text}`);
      }
    } catch (error) {
      if (attempt < maxAttempts - 1) {
        await new Promise((r) => setTimeout(r, attemptInterval));
      }
    }
  }

  throw new Error("Failed to generate text from Gemini");
};

const ACTION_KEY = "actionName" as const;
interface ActionCall extends Record<string, unknown> {
  [ACTION_KEY]: string;
}

const reasoningSchema = z.object({
  reasoningForDecision: z.string(),
});

const createDecisionSchema = (actionRegistry: ActionRegistry) => {
  const [first, ...rest] = Object.entries(actionRegistry).map(([name, def]) =>
    z.object({
      [ACTION_KEY]: z.literal(name),
      ...def.args.shape,
    }),
  );
  const actionSchema = first
    ? z.discriminatedUnion(ACTION_KEY, [first, ...rest])
    : z.null();
  const outputSchema = z.object({
    dataForJson: z.string(),
    csv: z.record(z.string(), z.array(z.array(z.string()))),
  });

  return z.discriminatedUnion("success", [
    z.object({
      ...reasoningSchema.shape,
      success: z.literal(true),
      summary: z.string(),
      ...outputSchema.shape,
    }),
    z.object({
      ...reasoningSchema.shape,
      success: z.literal(false),
    }),
    z.object({
      ...reasoningSchema.shape,
      success: z.literal(null),
      viewportDescriptions: z.string(),
      actions: z.array(actionSchema),
      ...outputSchema.shape,
      newMemories: z.record(z.string(), z.string()),
    }),
  ]);
};

interface HistoryItem {
  info: z.infer<typeof reasoningSchema>;
  actions: ActionCall[];
  actionResult: string;
}

type AiDecide = (
  task: Task,
  state: {
    tabs: {
      id: number;
      isLoading: boolean;
      url: string;
      title: string;
    }[];
    activeTab: {
      id: number;
      totalHeight: number;
      scrollPosition: number;
      screenshot: string;
      width: number;
      height: number;
      snapshot: Snapshot;
    };
  },
  history: HistoryItem[],
  viewportDescriptions: string,
  memories: Record<string, string>,
  actionRegistry: ActionRegistry,
) => Promise<z.infer<ReturnType<typeof createDecisionSchema>>>;

type AiFormatJsonOutput = <T>(
  instructions: string,
  summary: string,
  data: string[],
  jsonOutputSchema: z.ZodType<T>,
) => Promise<T>;

interface Ai {
  decide: AiDecide;
  formatJsonOutput: AiFormatJsonOutput;
}

const createAi = (genAI: GoogleGenAI): Ai => {
  const generate = async <T = object>(
    contents: (string | Part)[],
    schema: z.ZodSchema<T>,
  ) =>
    await generateText(
      genAI,
      [`The current time is: ${new Date().toISOString()}`, ...contents],
      schema,
    );

  const decide: AiDecide = async (
    task,
    state,
    history,
    viewportDescriptions,
    memories,
    actionRegistry,
  ) => {
    const { width, height, snapshot } = state.activeTab;
    const processCoord = (coord: Coord): { x: number; y: number } => ({
      x: Math.round((coord[0] * 1_000) / width),
      y: Math.round((coord[1] * 1_000) / height),
    });
    const process = <T extends { coord: Coord }>(items: T[]) =>
      Object.fromEntries(
        items.map((item, idx) => [
          idx,
          { ...item, coord: processCoord(item.coord) },
        ]),
      );
    const processedSnapshot = {
      links: process(snapshot.links),
      inputs: process(snapshot.inputs),
      textareas: process(snapshot.textareas),
      selects: process(snapshot.selects),
    };

    return await generate(
      [
        `
The user wants to achieve the following goal in a web browser: ${task.instructions}
The user specified the following URL to start from: ${task.initialURL}
The user has a set of secret strings, available under the following keys: ${JSON.stringify(Object.keys(task.secrets))}
The user wants to eventually achieve a result consisting of a JSON object and a set of CSV files.
JSON output schema: ${z.toJSONSchema(task.jsonOutputSchema)}
CSV output schemas: ${JSON.stringify(task.csvOutputSchemas)}
        `.trim(),
        `
Currently, the following tabs are open: ${JSON.stringify(state.tabs)}
The active tab ID is: ${state.activeTab.id}
The height of the active tab is ${Math.round((state.activeTab.totalHeight * 1_000) / width)} pixels, and its current scroll position is ${Math.round((state.activeTab.scrollPosition * 1_000) / height)} pixels from the top.
The following image is a screenshot of the viewport:
        `.trim(),
        createImagePart(state.activeTab.screenshot, "image/png"),
        `
The following is a mapping from link element IDs to their coordinates and URLs: ${JSON.stringify(processedSnapshot.links)}
The following is a mapping from input element IDs to their coordinates, types, and current values: ${JSON.stringify(processedSnapshot.inputs)}
The following is a mapping from textarea element IDs to their coordinates and current values: ${JSON.stringify(processedSnapshot.textareas)}
The following is a mapping from select element IDs to their coordinates, available options, and whether multiple options can be selected: ${JSON.stringify(processedSnapshot.selects)}
        `.trim(),
        `
History of actions performed so far: ${JSON.stringify(history)}
Descriptions of past screenshots, according to your understanding of how the visited websites work: ${viewportDescriptions}
        `.trim(),
        `
Memories you've saved so far: ${JSON.stringify(memories)}
        `.trim(),
        `
Your task is to decide whether
- the user's goal has been achieved and all needed data has been gathered (success: true), or
- the user's goal cannot be feasibly achieved at all, perhaps because you're stuck with a website bug or an anti-bot obstacle like a captcha (success: false), or
- the goal can be achieved and an action needs to be taken to progress (success: null)

If you decide on (success: false) because of an anti-bot obstacle, you must start the reasoningForDecision with "[ANTI-BOT]".

If you decide on (success: null), you must provide the following details:
- actions: the sequence of actions to take, with all their parameters (do not miss any parameters)
- dataForJson: any information (in any convenient format, not necessarily JSON) that should eventually be included in the JSON output
- csv: any rows that will be included in the CSV outputs, keyed by the CSV schema name
- newMemories: new memories to save, keyed by the memory name
- viewportDescriptions: a summarized list describing the important/relevant things in the past screenshots as well as the current one, according to your current understanding of how the visited websites work

Note that anything you put in 'dataForJson' or 'csv' won't be shown to you after this step.
If you want to save information for later, put it in 'newMemories' instead. Memories will be shown to you in next steps, but won't be included in the final output.
New memories with the same name will overwrite existing ones. To delete an existing memory, set its value to empty string.

Note that all given coordinates, as well as any coordinates you'll return, are according to the provided screenshot dimensions (1000x1000 pixels).
Before giving the coordinates, visually refine them only once. For coordinates ALWAYS use pixel precision instead of thinking about the surrounding elements,even if your previous click was nearby. Never base your coordinates based on your assumption of the size of an element or the pixel distance between elements.
Never try to predict or guess URLs yourself. You may only navigate to or use URLs that are explicitly provided to you.
Remember that you do not have the ability to read PDF files.

actions can contain more than one action, but only if they can be performed sequentially on the same page. For example, you can click somewhere then type somewhere else, but you cannot navigate then click.
When specifying multiple actions, they will be performed sequentially, but stopping if any of them fails. For example, if a click action opens a new URL, the next actions won't work.
Be extra careful when specifying multiple actions. For example, clicking on an element may show/hide other elements, changing the coordinates of the next elements to target.

Available actions: ${JSON.stringify(Object.entries(actionRegistry).map(([name, def]) => `${name}: ${def.description}`))}

In any case, you must provide:
- reasoningForDecision: an explanation of why you chose this particular action, considering similar alternatives
- viewportDescription: a consise paragraph describing the important/relevant things in the screenshot

General rules: You must strictly adhere to the user's goal and match the output schemas exactly. Semantic flexibility must be kept to a minimum.
`.trim(),
      ],
      createDecisionSchema(actionRegistry),
    );
  };

  const formatJsonOutput: AiFormatJsonOutput = async (
    instructions,
    summary,
    data,
    jsonOutputSchema,
  ) => {
    return await generate(
      [
        `
The user successfully achieved the following goal in a web browser: ${instructions}
The following summary was provided: ${summary}
During the process, the following data was collected: ${JSON.stringify(data)}
Your task is to format the collected data according to the required schema.
        `.trim(),
      ],
      jsonOutputSchema,
    );
  };

  return { decide, formatJsonOutput };
};

export {
  type Task,
  ACTION_KEY,
  type ActionCall,
  type HistoryItem,
  type Ai,
  createAi,
};
