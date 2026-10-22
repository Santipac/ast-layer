import { useEffect, useState } from "react";

// same hook, different names and formatting
export const useDebounce = <V,>(input: V, wait: number): V => {
  const [current, setCurrent] = useState(input);
  useEffect(() => {
    const t = setTimeout(() => { setCurrent(input); }, wait);
    return () => { clearTimeout(t); };
  }, [input, wait]);
  return current;
};
