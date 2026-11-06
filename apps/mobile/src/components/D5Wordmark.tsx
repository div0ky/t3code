import type { ColorValue } from "react-native";
import Svg, { Path } from "react-native-svg";
import { withUniwind } from "uniwind";

const ThemedPath = withUniwind(Path);

export function D5Wordmark(props: {
  readonly height: number;
  readonly color?: ColorValue;
  readonly colorClassName?: string;
}) {
  const aspectRatio = 103 / 56.96;
  return (
    <Svg
      accessibilityLabel="D5"
      height={props.height}
      width={props.height * aspectRatio}
      viewBox="12.5 37 103 56.96"
    >
      <ThemedPath
        d="M12.5 37H37.5C55.1 37 66.9 48.2 66.9 65C66.9 81.8 55.1 93 37.5 93H12.5ZM25.5 47.6V82.4H36.9C47.1 82.4 53.5 75.6 53.5 65C53.5 54.4 47.1 47.6 36.9 47.6ZM78.7 37H112.5V47.6H89.5L88.4 57.9C89.8 57.7 91.3 57.6 92.8 57.6C106.7 57.6 115.5 65 115.5 75.5C115.5 86.6 106.3 93.96 93.9 93.96C86.1 93.96 78.8 91.6 73.8 87.6L78.7 77.9C82.9 81.2 88.1 83.3 93.3 83.3C99.1 83.3 102.7 80.3 102.7 75.7C102.7 70.8 98.7 67.7 92 67.7C86.8 67.7 81.2 68.8 75.8 70.6Z"
        color={props.color}
        colorClassName={props.colorClassName}
        fill="currentColor"
      />
    </Svg>
  );
}
