/**
 * Realistic .pen document fixture shaped per the documented Pencil schema.
 * See docs/PEN-FORMAT.md for the authoritative field reference.
 *
 * Used across pen-snapshot, pen-to-code, and future parser tests to exercise
 * the complex value shapes that hand-rolled scalar fixtures cannot cover.
 */

export interface PenFixtureDocument {
  version: string;
  themes: Record<string, unknown>;
  variables: Record<string, unknown>;
  children: unknown[];
}

/** Gradient object as allowed by the real .pen fill field */
export const gradientFill = {
  type: "linear",
  angle: 135,
  stops: [
    { color: "#667eea", position: 0 },
    { color: "#764ba2", position: 1 },
  ],
};

/** A different gradient (distinct from gradientFill) */
export const gradientFillAlt = {
  type: "linear",
  angle: 135,
  stops: [
    { color: "#ff6b6b", position: 0 },
    { color: "#feca57", position: 1 },
  ],
};

/** Per-side cornerRadius array [top, right, bottom, left] */
export const cornerRadiusPerSide: [number, number, number, number] = [8, 8, 0, 0];
export const cornerRadiusUniform: [number, number, number, number] = [8, 8, 8, 8];

/** A reusable component definition */
export const reusableButton = {
  id: "btn-base",
  name: "ButtonBase",
  type: "frame",
  reusable: true,
  fill: "#667eea",
  cornerRadius: 4,
  width: 120,
  height: 40,
  children: [],
};

/** A ref node pointing at the reusable component */
export const refNode = {
  id: "btn-instance-1",
  name: "PrimaryButton",
  type: "ref",
  ref: "btn-base",
  x: 100,
  y: 200,
};

/** Full realistic document */
export const realisticPenDoc: PenFixtureDocument = {
  version: "2.13",
  themes: {
    light: { background: "#ffffff", primary: "#667eea" },
    dark: { background: "#1a1a2e", primary: "#764ba2" },
  },
  variables: {
    "color-primary": "#667eea",
    "color-secondary": "#764ba2",
    "spacing-base": "8px",
    "font-size-base": "16px",
  },
  children: [
    {
      id: "page-home",
      name: "HomePage",
      type: "frame",
      fill: "#f0f0f0",
      width: 1440,
      height: 900,
      children: [
        {
          id: "hero-section",
          name: "HeroSection",
          type: "frame",
          fill: gradientFill,
          cornerRadius: cornerRadiusPerSide,
          width: 1440,
          height: 480,
          children: [
            {
              id: "hero-title",
              name: "HeroTitle",
              type: "text",
              content: "Design on canvas. Land in code.",
              fontFamily: "Inter",
              fontSize: 48,
              fontWeight: "700",
              fill: "#ffffff",
            },
          ],
        },
        {
          id: "cta-button",
          name: "CTAButton",
          type: "frame",
          fill: [
            { type: "solid", color: "#667eea" },
            { type: "solid", color: "#764ba2", opacity: 0.2 },
          ],
          cornerRadius: 8,
          width: 200,
          height: 56,
          children: [],
        },
        reusableButton,
        refNode,
      ],
    },
  ],
};

export function serializeDoc(doc: PenFixtureDocument): string {
  return JSON.stringify(doc);
}
