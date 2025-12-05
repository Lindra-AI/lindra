type Coord = [number, number];

interface Input {
  coord: Coord;
  type: string;
  value: string;
}

interface Textarea {
  coord: Coord;
  value: string;
}

interface Select {
  coord: Coord;
  options: { value: string; text: string; selected: boolean }[];
  canSelectMultiple: boolean;
}

interface Link {
  coord: Coord;
  href: string;
}

interface Snapshot {
  inputs: Input[];
  textareas: Textarea[];
  selects: Select[];
  links: Link[];
}

const getScrollData = (): { totalHeight: number; scrollPosition: number } => {
  const bodyHeight = document.body.scrollHeight;
  const bodyTop = document.body.scrollTop;
  const htmlHeight = document.documentElement.scrollHeight;
  const htmlTop = document.documentElement.scrollTop;

  return {
    totalHeight: Math.max(bodyHeight, htmlHeight),
    scrollPosition: Math.max(bodyTop, htmlTop),
  };
};

const scroll = ({
  coord,
  multiplier,
  vertical,
}: {
  coord: Coord;
  multiplier: number;
  vertical: boolean;
}): number | null => {
  const isScrollable = (element: Element): boolean => {
    const style = window.getComputedStyle(element);
    if (element instanceof HTMLHtmlElement) return true;
    return (
      ["scroll", "auto"].includes(
        vertical ? style.overflowY : style.overflowX,
      ) &&
      (vertical
        ? element.scrollHeight > element.clientHeight
        : element.scrollWidth > element.clientWidth)
    );
  };

  const element = document.elementFromPoint(coord[0], coord[1]);
  if (element === null) return null;

  let currentElement: Element | null = element;
  let steps = 0;
  while (currentElement !== null) {
    if (isScrollable(currentElement)) {
      const pixels = Math.round(
        multiplier *
          (vertical ? currentElement.clientHeight : currentElement.clientWidth),
      );
      currentElement.scrollBy(vertical ? 0 : pixels, vertical ? pixels : 0);
      return steps;
    }
    currentElement = currentElement.parentElement!;
    steps++;
  }
  return null;
};

const typeText = ({
  coord,
  text,
  pressEnter,
}: {
  coord: Coord;
  text: string;
  pressEnter: boolean;
}): void => {
  const element = document.elementFromPoint(coord[0], coord[1]);
  if (
    !(
      element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement
    )
  )
    return;

  element.focus();
  element.select();
  const proto =
    element instanceof HTMLInputElement
      ? HTMLInputElement.prototype
      : HTMLTextAreaElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(element, text);
  element.dispatchEvent(new InputEvent("input", { bubbles: true, data: text }));
  if (pressEnter) {
    element.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
  }
};

const selectOption = ({
  coord,
  values,
}: {
  coord: Coord;
  values: string[];
}): void => {
  const element = document.elementFromPoint(coord[0], coord[1]);
  if (!(element instanceof HTMLSelectElement)) return;

  for (const option of element.options) {
    option.selected = values.includes(option.value);
  }
  element.dispatchEvent(new Event("change", { bubbles: true }));
};

const snapshot = (): Snapshot => {
  const isInViewport = (element: Element): boolean => {
    const rect = element.getBoundingClientRect();
    return (
      rect.bottom > 0 &&
      rect.top < innerHeight &&
      rect.right > 0 &&
      rect.left < innerWidth
    );
  };

  const getVisibleBounds = (element: Element) => {
    const rect = element.getBoundingClientRect();
    return {
      left: Math.max(rect.left, 0),
      top: Math.max(rect.top, 0),
      right: Math.min(rect.right, innerWidth),
      bottom: Math.min(rect.bottom, innerHeight),
    };
  };

  const findClickableCoord = (element: Element): Coord | null => {
    const { left, top, right, bottom } = getVisibleBounds(element);
    const centerX = Math.round((left + right) / 2);
    const centerY = Math.round((top + bottom) / 2);

    const elementAtCenter = document.elementFromPoint(centerX, centerY);
    if (
      elementAtCenter &&
      (element === elementAtCenter || element.contains(elementAtCenter))
    ) {
      return [centerX, centerY];
    }

    const stepX = (right - left) / 4;
    const stepY = (bottom - top) / 4;
    for (let y = top + stepY; y < bottom; y += stepY) {
      for (let x = left + stepX; x < right; x += stepX) {
        const elementAtPoint = document.elementFromPoint(x, y);
        if (
          elementAtPoint &&
          (element === elementAtPoint || element.contains(elementAtPoint))
        ) {
          return [Math.round(x), Math.round(y)];
        }
      }
    }

    return null;
  };

  const queryVisible = <E extends Element, T extends { coord: Coord }>(
    selector: string,
    mapper: (element: E, coord: Coord) => T,
  ): T[] => {
    return Array.from(document.querySelectorAll<E>(selector))
      .filter(isInViewport)
      .map((element) => {
        const coord = findClickableCoord(element);
        return coord ? mapper(element, coord) : null;
      })
      .filter((item): item is T => item !== null);
  };

  const cleanText = (text: string): string => {
    return text.replace(/\s+/g, " ").trim();
  };

  return {
    inputs: queryVisible<HTMLInputElement, Input>(
      "input",
      (element, coord) => ({
        coord,
        type: element.type,
        value: element.value,
      }),
    ),
    textareas: queryVisible<HTMLTextAreaElement, Textarea>(
      "textarea",
      (element, coord) => ({
        coord,
        value: element.value,
      }),
    ),
    selects: queryVisible<HTMLSelectElement, Select>(
      "select",
      (element, coord) => ({
        coord,
        options: Array.from(element.options).map((opt) => ({
          value: opt.value,
          text: cleanText(opt.text),
          selected: opt.selected,
        })),
        canSelectMultiple: element.multiple,
      }),
    ),
    links: queryVisible<HTMLAnchorElement, Link>("a", (element, coord) => ({
      coord,
      href: element.href,
    })),
  };
};

export {
  type Coord,
  type Input,
  type Textarea,
  type Select,
  type Link,
  type Snapshot,
  getScrollData,
  scroll,
  typeText,
  selectOption,
  snapshot,
};
