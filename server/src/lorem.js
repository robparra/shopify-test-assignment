/**
 * Dependency-free Lorem Ipsum generator.
 * Uses `crypto.randomInt` so every order gets a genuinely different text.
 */
import { randomInt } from "node:crypto";

const WORDS = (
  "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor " +
  "incididunt ut labore et dolore magna aliqua enim ad minim veniam quis nostrud " +
  "exercitation ullamco laboris nisi aliquip ex ea commodo consequat duis aute irure " +
  "in reprehenderit voluptate velit esse cillum fugiat nulla pariatur excepteur sint " +
  "occaecat cupidatat non proident sunt culpa qui officia deserunt mollit anim id est " +
  "laborum curabitur pretium tincidunt lacus nulla gravida orci a odio nullam varius " +
  "turpis et commodo pharetra est eros bibendum elit nec luctus magna felis sollicitudin " +
  "mauris integer dignissim viverra accumsan vestibulum fermentum tortor lectus"
).split(" ");

/** Random integer in the inclusive range [min, max]. */
const between = (min, max) => randomInt(min, max + 1);

export function sentence({ minWords = 6, maxWords = 14 } = {}) {
  const count = between(minWords, maxWords);
  const words = Array.from({ length: count }, () => WORDS[randomInt(WORDS.length)]);
  // Add a comma somewhere in the middle of longer sentences for a natural look.
  if (count > 8) words[between(3, count - 3)] += ",";
  const text = words.join(" ");
  return text.charAt(0).toUpperCase() + text.slice(1) + ".";
}

export function paragraph({ minSentences = 3, maxSentences = 6 } = {}) {
  return Array.from({ length: between(minSentences, maxSentences) }, () => sentence()).join(" ");
}

/**
 * Generates 1–3 paragraphs separated by blank lines
 * (fits the `multi_line_text_field` metafield type).
 */
export function generateLoremIpsum({ minParagraphs = 1, maxParagraphs = 3 } = {}) {
  return Array.from({ length: between(minParagraphs, maxParagraphs) }, () => paragraph()).join("\n\n");
}
