// Pet registry: each pet supplies the site icon, favicon, and the little
// traveler under the terminal. Biblical Claude is SVG-drawn (the ophanim in
// Mascot.svelte / Rail.svelte); the others are glyph pets — three centered
// monospace lines where the middle line is the face and idles can swap it.

export type PetId = "biblical" | "cybercat" | "foxtrix";

export interface PetIdle {
  anim: string; // maps to .idle-<anim> on .mascot-hopper (keyframes in app.css)
  ms: number;   // must match the CSS animation duration
  face?: string; // temporary face line while the idle plays (glyph pets only)
}

export interface PetDef {
  id: PetId;
  label: string;
  favicon: string;
  lines?: [string, string, string]; // glyph pets only
  ink?: string;  // sprite color (glyph pets)
  glow?: string; // drop-shadow color (glyph pets)
  idles: PetIdle[];
}

export const PETS: Record<PetId, PetDef> = {
  biblical: {
    id: "biblical",
    label: "Biblical Claude",
    favicon: "/icon.svg",
    idles: [
      { anim: "bounce", ms: 1300 },
      { anim: "spin", ms: 900 },
    ],
  },
  cybercat: {
    id: "cybercat",
    label: "Cybercat",
    favicon: "/pet-cybercat.svg",
    lines: ["/\\_/\\", "( o.o )", "> ^ <"],
    ink: "#9be8ff",
    glow: "rgba(94,231,255,.4)",
    idles: [
      { anim: "peer", ms: 1800, face: "( O.O )" },  // leans in to look at you
      { anim: "groom", ms: 1900, face: "( -.- )" }, // tips over, licks a paw
    ],
  },
  foxtrix: {
    id: "foxtrix",
    label: "Foxtrix",
    favicon: "/pet-foxtrix.svg",
    lines: ["/\\ /\\", "=( ･ᴥ･ )=", "∪ ∪"],
    ink: "#ffb27d",
    glow: "rgba(255,154,60,.4)",
    idles: [
      { anim: "peer", ms: 1800, face: "=( 0ᴥ0 )=" },
      { anim: "wag", ms: 1400, face: "=( -ᴥ- )=" },
    ],
  },
};

export function petOrDefault(id: string | null | undefined): PetDef {
  return PETS[(id ?? "biblical") as PetId] ?? PETS.biblical;
}
