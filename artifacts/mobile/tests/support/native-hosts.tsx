// Host-only adapter: render the real dashboard components and real query hooks
// without requiring an iOS/Android renderer. Native gestures/layout are not
// claimed as covered by these component tests.
import React, { type ReactNode } from "react";

type Props = { children?: ReactNode; testID?: string; onPress?: () => void; visible?: boolean; disabled?: boolean };
const host = (tag: "div" | "span" | "button" | "input") =>
  function Host({ children, testID, onPress, disabled }: Props) {
    return React.createElement(tag, { "data-testid": testID, onClick: onPress, disabled }, children);
  };

export const View = host("div");
export const Text = host("span");
export const ScrollView = host("div");
export const TouchableOpacity = host("button");
export const Pressable = host("button");
export const TextInput = ({ value, onChangeText, placeholder }: {
  value?: string; onChangeText?: (value: string) => void; placeholder?: string;
}) => <input value={value} placeholder={placeholder} onChange={event => onChangeText?.(event.target.value)} />;
export const Image = () => null;
export const useWindowDimensions = () => ({ width: 400, height: 800 });
export const Modal = ({ children, visible }: Props) => visible ? <div>{children}</div> : null;
export const ActivityIndicator = () => <span role="progressbar" />;
export const Platform = { OS: "web", select: (values: Record<string, unknown>) => values.web ?? values.default };
export const StyleSheet = { create: <T,>(styles: T): T => styles, hairlineWidth: 1 };
export const Alert = { alert: () => undefined };
export const Linking = { openURL: async (_url: string) => undefined };
export const RefreshControl = () => null;
export function FlatList<T>({ data, renderItem, ListEmptyComponent }: {
  data: T[]; renderItem: (info: { item: T }) => ReactNode; ListEmptyComponent?: ReactNode;
}) {
  return <div>{data.length ? data.map((item, index) => <React.Fragment key={index}>{renderItem({ item })}</React.Fragment>) : ListEmptyComponent}</div>;
}
