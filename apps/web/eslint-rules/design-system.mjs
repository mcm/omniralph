// Local ESLint rules that keep the panel's styling inside the design system
// (apps/web/DESIGN.md, @iamthemcmaster/ui): no raw color literals, no inline
// layout/spacing/color/typography/size styles, no arbitrary Tailwind values.
// Tested in design-system.test.ts; wired up in apps/web/eslint.config.mjs.

// Hex colors (#rgb, #rgba, #rrggbb, #rrggbbaa) as a standalone token. All-digit
// 3/4-character tokens are skipped: they are far more often issue numbers (#123).
const HEX_COLOR = /(?:^|[^\w&/#-])#([0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})(?![\w-])/gi;
const FUNCTIONAL_COLOR = /\b(?:rgba?|hsla?)\(/i;

/** The raw color literal in `text`, if any. */
export function findRawColor(text) {
  for (const match of text.matchAll(HEX_COLOR)) {
    const digits = match[1];
    if (digits.length <= 4 && /^\d+$/.test(digits)) continue;
    return `#${digits}`;
  }
  const functional = FUNCTIONAL_COLOR.exec(text);
  return functional ? functional[0] : null;
}

// Inline style properties the design system owns, by category.
const STYLED_PROPERTY = new RegExp(
  "^(?:" +
    [
      // layout
      "display|position|inset\\w*|top|right|bottom|left|zIndex|float|clear|overflow\\w*|visibility",
      "flex\\w*|grid\\w*|align\\w*|justify\\w*|place\\w*|gap|rowGap|columnGap|order|boxSizing|verticalAlign",
      // spacing
      "margin\\w*|padding\\w*",
      // color
      "color|background\\w*|border\\w*|outline\\w*|boxShadow|fill|stroke|accentColor|caretColor|opacity",
      // typography
      "font\\w*|lineHeight|letterSpacing|text\\w*|whiteSpace|wordBreak|overflowWrap|wordWrap",
      // size
      "width|height|(?:min|max)(?:Width|Height|BlockSize|InlineSize)|aspectRatio|blockSize|inlineSize",
    ].join("|") +
    ")$",
);

/** Whether a style value is a literal (or a choice between literals) rather than computed. */
function isLiteralValue(node) {
  switch (node.type) {
    case "Literal":
      return true;
    case "TemplateLiteral":
      return node.expressions.length === 0;
    case "UnaryExpression":
      return node.operator === "-" && isLiteralValue(node.argument);
    case "ConditionalExpression":
      return isLiteralValue(node.consequent) && isLiteralValue(node.alternate);
    case "TSAsExpression":
    case "TSSatisfiesExpression":
      return isLiteralValue(node.expression);
    default:
      return false;
  }
}

function propertyName(property) {
  if (property.computed) return null;
  if (property.key.type === "Identifier") return property.key.name;
  if (property.key.type === "Literal" && typeof property.key.value === "string") {
    return property.key.value;
  }
  return null;
}

const DYNAMIC_STYLE_COMMENT = /^\s*\*?\s*dynamic-style:\s*\S/;

/** Whether the line before `node` has a `// dynamic-style: <reason>` comment. */
function hasDynamicStyleComment(sourceCode, node) {
  const line = node.loc.start.line;
  return sourceCode
    .getAllComments()
    .some(
      (comment) => comment.loc.end.line === line - 1 && DYNAMIC_STYLE_COMMENT.test(comment.value),
    );
}

function jsxAttributeName(node) {
  if (node.type !== "JSXAttribute") return null;
  return node.name.type === "JSXIdentifier" ? node.name.name : null;
}

/** The nearest enclosing JSX attribute's name, if the node sits inside one. */
function enclosingAttributeName(node) {
  for (let current = node.parent; current; current = current.parent) {
    if (current.type === "JSXAttribute") return jsxAttributeName(current);
    if (current.type === "JSXElement" || current.type === "JSXFragment") return null;
  }
  return null;
}

// Attributes whose values are URLs or ids, where `#abc` is a fragment, not a color.
const URL_ATTRIBUTES = new Set(["href", "src", "action", "formAction", "id", "htmlFor", "to"]);

/** String pieces of a node to scan: a string literal's value or a template's raw chunks. */
function stringsOf(node) {
  if (node.type === "Literal" && typeof node.value === "string") return [node.value];
  if (node.type === "TemplateLiteral") return node.quasis.map((quasi) => quasi.value.raw);
  return [];
}

/** @type {import("eslint").Rule.RuleModule} */
export const noRawColor = {
  meta: {
    type: "suggestion",
    docs: { description: "Disallow hex, rgb()/rgba() and hsl()/hsla() color literals" },
    schema: [],
    messages: {
      rawColor:
        "Raw color {{color}}: use a design-system token (var(--…)) or a library variant instead.",
    },
  },
  create(context) {
    function check(node) {
      const parent = node.parent;
      if (parent.type === "ImportDeclaration" || parent.type === "ExportNamedDeclaration") return;
      if (parent.type === "ExportAllDeclaration" || parent.type === "ImportExpression") return;
      if (parent.type === "TaggedTemplateExpression") return;
      if (URL_ATTRIBUTES.has(enclosingAttributeName(node) ?? "")) return;
      for (const text of stringsOf(node)) {
        const color = findRawColor(text);
        if (color) {
          context.report({ node, messageId: "rawColor", data: { color } });
          return;
        }
      }
    }
    return { Literal: check, TemplateLiteral: check };
  },
};

function unwrapTypeAssertions(node) {
  let current = node;
  while (current?.type === "TSAsExpression" || current?.type === "TSSatisfiesExpression") {
    current = current.expression;
  }
  return current;
}

/**
 * The object literal a style prop sets: inline (`style={{…}}`) or a `const` holding one
 * (`const stack: CSSProperties = {…}; style={stack}`), so hoisting a style doesn't hide it.
 */
function styleObject(sourceCode, expression) {
  const node = unwrapTypeAssertions(expression);
  if (node.type === "ObjectExpression") return node;
  if (node.type !== "Identifier") return null;
  let scope = sourceCode.getScope(node);
  while (scope) {
    const variable = scope.set.get(node.name);
    if (variable) {
      const definition = variable.defs.length === 1 ? variable.defs[0] : null;
      const declarator = definition?.node;
      if (declarator?.type !== "VariableDeclarator" || declarator.parent.kind !== "const")
        return null;
      const init = unwrapTypeAssertions(declarator.init);
      return init?.type === "ObjectExpression" ? init : null;
    }
    scope = scope.upper;
  }
  return null;
}

/** @type {import("eslint").Rule.RuleModule} */
export const noInlineLayoutStyle = {
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Disallow style={{…}} props that set layout, spacing, color, typography or size to literal values",
    },
    schema: [],
    messages: {
      inlineStyle:
        "Inline style sets {{properties}} to literal values: use a library primitive or variant. " +
        "If the value really is dynamic, add `// dynamic-style: <reason>` on the line before.",
    },
  },
  create(context) {
    const sourceCode = context.sourceCode;
    return {
      JSXAttribute(node) {
        if (jsxAttributeName(node) !== "style") return;
        const container =
          node.value?.type === "JSXExpressionContainer" ? node.value.expression : null;
        const expression = container && styleObject(sourceCode, container);
        if (!expression) return;
        const properties = expression.properties
          .filter((property) => property.type === "Property")
          .filter((property) => STYLED_PROPERTY.test(propertyName(property) ?? ""))
          .filter((property) => isLiteralValue(property.value))
          .map((property) => propertyName(property));
        if (properties.length === 0) return;
        if (hasDynamicStyleComment(sourceCode, node)) return;
        context.report({
          node,
          messageId: "inlineStyle",
          data: { properties: properties.join(", ") },
        });
      },
    };
  },
};

// A Tailwind class with an arbitrary value: `text-[13px]`, `md:p-[3px]`, `-mt-[2px]`, `w-[calc(100%-1rem)]`.
const ARBITRARY_VALUE = /(?:^|\s)!?(?:[\w-]+:)*!?-?[a-z][\w-]*-\[[^\]\s]+\]/i;

// Functions that build class names.
const CLASS_FUNCTIONS = new Set([
  "cn",
  "clsx",
  "classNames",
  "classnames",
  "cva",
  "cx",
  "twMerge",
  "twJoin",
]);

function isInClassNameContext(node) {
  for (let current = node.parent; current; current = current.parent) {
    if (current.type === "JSXAttribute") {
      const name = jsxAttributeName(current) ?? "";
      return name === "className" || name === "class" || name.endsWith("ClassName");
    }
    if (current.type === "CallExpression" && current.callee.type === "Identifier") {
      if (CLASS_FUNCTIONS.has(current.callee.name)) return true;
    }
    if (current.type === "JSXElement" || current.type === "JSXFragment") return false;
  }
  return false;
}

/** @type {import("eslint").Rule.RuleModule} */
export const noArbitraryTailwind = {
  meta: {
    type: "suggestion",
    docs: { description: "Disallow arbitrary Tailwind values such as text-[13px] or gap-[7px]" },
    schema: [],
    messages: {
      arbitraryValue:
        "Arbitrary Tailwind value {{value}}: use a design-system token or library primitive instead.",
    },
  },
  create(context) {
    function check(node) {
      if (!isInClassNameContext(node)) return;
      for (const text of stringsOf(node)) {
        const match = ARBITRARY_VALUE.exec(text);
        if (match) {
          context.report({ node, messageId: "arbitraryValue", data: { value: match[0].trim() } });
          return;
        }
      }
    }
    return { Literal: check, TemplateLiteral: check };
  },
};

const plugin = {
  meta: { name: "design-system" },
  rules: {
    "no-raw-color": noRawColor,
    "no-inline-layout-style": noInlineLayoutStyle,
    "no-arbitrary-tailwind": noArbitraryTailwind,
  },
};

export default plugin;
