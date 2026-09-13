export type ActivityId = "blackjack" | "piano" | "flyout" | "flypv";

export interface ActivityDefinition {
  id: ActivityId;
  title: string;
  href: string;
  tableLabel: string;
  decisionLabel: string;
  sensoryTrace: string[];
  motorTrace: string[];
}

const base = import.meta.env.BASE_URL;
export const activities: ActivityDefinition[] = [
  {
    id: "blackjack",
    title: "Blackjack Table",
    href: base === "/" ? "/" : `${base}housefly/`,
    tableLabel: "BLACKJACK",
    decisionLabel: "Hit / Stand / Double / Split",
    sensoryTrace: ["optic", "mushroom", "central"],
    motorTrace: ["central", "dn", "vnc"]
  },
  { id: "piano", title: "Flythoven", href: `${base}simulations/piano/`, tableLabel: "FLYTHOVEN", decisionLabel: "Score / Notes / Tempo", sensoryTrace: [], motorTrace: [] },
  { id: "flyout", title: "Flyout", href: `${base}simulations/flyout/`, tableLabel: "FLYOUT", decisionLabel: "Pitch / Swing / Field / Throw", sensoryTrace: [], motorTrace: [] },
  { id: "flypv", title: "Flylot", href: `${base}simulations/flypv/`, tableLabel: "FLYLOT", decisionLabel: "Throttle / Steer / Altitude", sensoryTrace: [], motorTrace: [] }
];

export const activeActivity = activities[0];
