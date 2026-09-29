import { useState } from "react";
import { KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { categoryLabel, formatQuantity, parseAmount, roundMoney } from "../lib/format";
import { CATEGORIES, type Category, type ReceiptItem } from "../lib/types";
import { radius, space, useTheme } from "../theme";
import { Button, Text } from "./ui";

type Props = {
  item: ReceiptItem | null;
  visible: boolean;
  onClose: () => void;
  onSave: (item: ReceiptItem) => void;
  onDelete?: () => void;
};

export function Field({
  label,
  value,
  onChangeText,
  keyboardType,
  placeholder,
  autoFocus,
}: {
  label: string;
  value: string;
  onChangeText: (v: string) => void;
  keyboardType?: "default" | "decimal-pad" | "numbers-and-punctuation";
  placeholder?: string;
  autoFocus?: boolean;
}) {
  const { colors } = useTheme();
  return (
    <View style={{ gap: 6, flex: 1 }}>
      <Text variant="caption" tone="muted">
        {label}
      </Text>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        keyboardType={keyboardType}
        placeholder={placeholder}
        placeholderTextColor={colors.textFaint}
        autoFocus={autoFocus}
        style={[styles.input, { backgroundColor: colors.surfaceMuted, color: colors.text }]}
      />
    </View>
  );
}

/** Numeric input that keeps the raw text (so "12." or "0,5" can be typed) and reports the parsed value. */
export function AmountField({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: number | null;
  onChange: (value: number | null) => void;
  placeholder?: string;
}) {
  const [text, setText] = useState(value === null ? "" : String(value));
  const [lastValue, setLastValue] = useState(value);
  // Only overwrite the text when the value changed from outside this field.
  if (value !== lastValue) {
    setLastValue(value);
    if (parseAmount(text) !== value) setText(value === null ? "" : String(value));
  }
  return (
    <Field
      label={label}
      value={text}
      placeholder={placeholder}
      keyboardType="numbers-and-punctuation"
      onChangeText={(next) => {
        setText(next);
        onChange(parseAmount(next));
      }}
    />
  );
}

export function ItemEditor({ item, visible, onClose, onSave, onDelete }: Props) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={[StyleSheet.absoluteFill, { backgroundColor: colors.overlay }]} onPress={onClose} />
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.sheetWrap} pointerEvents="box-none">
        <View style={[styles.sheet, { backgroundColor: colors.surface, paddingBottom: insets.bottom + space.lg }]}>
          <View style={[styles.grabber, { backgroundColor: colors.border }]} />
          {/* Keyed so the form starts fresh each time a different item is opened. */}
          {visible ? <ItemForm key={item?.id ?? "new"} item={item} onSave={onSave} onDelete={onDelete} /> : null}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function ItemForm({ item, onSave, onDelete }: Pick<Props, "item" | "onSave" | "onDelete">) {
  const { colors } = useTheme();
  const [name, setName] = useState(item?.name ?? "");
  const [quantity, setQuantity] = useState(item ? formatQuantity(item.quantity) : "1");
  const [price, setPrice] = useState(item ? item.totalPrice.toFixed(2) : "");
  const [category, setCategory] = useState<Category>(item?.category ?? "groceries");
  const [error, setError] = useState<string | null>(null);

  const save = () => {
    const qty = parseAmount(quantity);
    const total = parseAmount(price);
    if (!name.trim()) return setError("Enter an item name.");
    if (qty === null || qty <= 0) return setError("Quantity must be more than 0.");
    if (total === null) return setError("Enter the line total.");
    const unitChanged = !item || qty !== item.quantity || total !== item.totalPrice;
    onSave({
      id: item?.id ?? "",
      name: name.trim(),
      quantity: qty,
      unitPrice: unitChanged ? roundMoney(total / qty) : (item?.unitPrice ?? null),
      totalPrice: roundMoney(total),
      category,
    });
  };

  return (
    <>
      <Text variant="title">{item ? "Edit item" : "Add item"}</Text>
      <Field label="Name" value={name} onChangeText={setName} placeholder="e.g. Whole milk 1L" autoFocus={!item} />
      <View style={{ flexDirection: "row", gap: space.md }}>
        <Field label="Quantity" value={quantity} onChangeText={setQuantity} keyboardType="decimal-pad" />
        <Field label="Line total" value={price} onChangeText={setPrice} keyboardType="numbers-and-punctuation" placeholder="0.00" />
      </View>
      <View style={{ gap: 6 }}>
        <Text variant="caption" tone="muted">
          Category
        </Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space.sm }}>
          {CATEGORIES.map((c) => {
            const selected = c === category;
            return (
              <Pressable
                key={c}
                onPress={() => setCategory(c)}
                style={[styles.chip, { backgroundColor: selected ? colors.accent : colors.surfaceMuted }]}
              >
                <Text variant="caption" tone={selected ? "onAccent" : "default"}>
                  {categoryLabel(c)}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>
      </View>
      {error ? <Text tone="danger">{error}</Text> : null}
      <Button title={item ? "Save changes" : "Add item"} onPress={save} />
      {onDelete ? <Button title="Remove item" variant="danger" icon="trash-outline" onPress={onDelete} /> : null}
    </>
  );
}

const styles = StyleSheet.create({
  sheetWrap: { flex: 1, justifyContent: "flex-end" },
  sheet: { borderTopLeftRadius: radius.xl, borderTopRightRadius: radius.xl, padding: space.xl, gap: space.lg },
  grabber: { alignSelf: "center", width: 40, height: 5, borderRadius: 3, marginTop: -space.sm },
  input: { minHeight: 50, borderRadius: radius.md, paddingHorizontal: space.lg, fontSize: 16 },
  chip: { paddingHorizontal: 14, paddingVertical: 9, borderRadius: radius.pill },
});
