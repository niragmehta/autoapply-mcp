import { h, Fragment, createContext } from "preact";
import htm from "htm";

/** Tagged-template JSX without a build step. */
export const html = htm.bind(h);
export { Fragment, createContext };
export {
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "preact/hooks";
