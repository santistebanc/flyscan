import { createContext } from "react";

/** Each carrier's color for the search on screen, from airlineColors. */
export const AirlineColors = createContext<ReadonlyMap<string, string>>(new Map());
