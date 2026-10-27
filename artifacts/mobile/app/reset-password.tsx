import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { useLocalSearchParams, useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import React, { useState } from "react";
import {
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ApiError, resetBusinessPassword } from "@workspace/api-client-react";

/**
 * Landing page for the emailed password-reset link
 * (`/reset-password?token=…`). Lets the provider choose a new password; the
 * token is single-use and expires 1 hour after it was requested.
 */
export default function ResetPasswordScreen() {
  const params = useLocalSearchParams<{ token?: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [visible, setVisible] = useState(false);
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const token = typeof params.token === "string" ? params.token : "";

  async function handleSubmit() {
    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    if (password !== confirm) {
      setError("Passwords don't match.");
      return;
    }
    setError(null);
    setLoading(true);
    try {
      await resetBusinessPassword({ token, password });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setDone(true);
    } catch (e) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      const msg =
        e instanceof ApiError
          ? ((e.data as { error?: string } | null)?.error ?? "This reset link is invalid or has expired.")
          : "Could not reach the server. Please try again.";
      setError(msg);
    } finally {
      setLoading(false);
    }
  }

  const missingToken = !token;

  return (
    <View style={[styles.container, { paddingTop: insets.top + 12, paddingBottom: insets.bottom + 12 }]}>
      <StatusBar style="light" />
      <KeyboardAwareScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        {done ? (
          <View style={styles.content}>
            <View style={[styles.iconCircle, { backgroundColor: "rgba(76,175,80,0.15)" }]}>
              <Feather name="check-circle" size={40} color="#66BB6A" />
            </View>
            <Text style={styles.title}>Password updated</Text>
            <Text style={styles.desc}>
              Your new password is ready to use. Sign in to your provider account to continue.
            </Text>
            <TouchableOpacity
              style={[styles.btn, { backgroundColor: "#5C6BC0" }]}
              onPress={() => router.replace("/login")}
              activeOpacity={0.85}
            >
              <Text style={styles.btnText}>Go to Sign In</Text>
              <Feather name="arrow-right" size={18} color="#fff" />
            </TouchableOpacity>
          </View>
        ) : missingToken ? (
          <View style={styles.content}>
            <View style={[styles.iconCircle, { backgroundColor: "rgba(239,83,80,0.15)" }]}>
              <Feather name="alert-circle" size={40} color="#EF5350" />
            </View>
            <Text style={styles.title}>Link problem</Text>
            <Text style={styles.desc}>
              This page needs the reset link from your email. Please open the link again, or request
              a new one.
            </Text>
            <TouchableOpacity
              style={[styles.btn, { backgroundColor: "#5C6BC0" }]}
              onPress={() => router.replace("/forgot-password")}
              activeOpacity={0.85}
            >
              <Text style={styles.btnText}>Request a New Link</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <View style={styles.content}>
            <View style={[styles.iconCircle, { backgroundColor: "rgba(92,107,192,0.18)" }]}>
              <Feather name="lock" size={40} color="#7986CB" />
            </View>
            <Text style={styles.title}>Choose a new password</Text>
            <Text style={styles.desc}>At least 8 characters. You'll use it to sign in to your provider account.</Text>

            <View style={{ width: "100%", marginTop: 8, gap: 14 }}>
              <View>
                <Text style={styles.fieldLabel}>New Password</Text>
                <View style={styles.inputRow}>
                  <Feather name="lock" size={16} color="rgba(255,255,255,0.5)" />
                  <TextInput
                    style={styles.input}
                    placeholder="••••••••"
                    placeholderTextColor="rgba(255,255,255,0.35)"
                    value={password}
                    onChangeText={setPassword}
                    secureTextEntry={!visible}
                    autoFocus={Platform.OS === "web"}
                  />
                  <TouchableOpacity onPress={() => setVisible(!visible)}>
                    <Feather name={visible ? "eye-off" : "eye"} size={16} color="rgba(255,255,255,0.4)" />
                  </TouchableOpacity>
                </View>
              </View>
              <View>
                <Text style={styles.fieldLabel}>Confirm Password</Text>
                <View style={styles.inputRow}>
                  <Feather name="lock" size={16} color="rgba(255,255,255,0.5)" />
                  <TextInput
                    style={styles.input}
                    placeholder="••••••••"
                    placeholderTextColor="rgba(255,255,255,0.35)"
                    value={confirm}
                    onChangeText={setConfirm}
                    secureTextEntry={!visible}
                    onSubmitEditing={handleSubmit}
                  />
                </View>
              </View>
              {error ? <Text style={styles.errorText}>{error}</Text> : null}
            </View>

            <TouchableOpacity
              style={[styles.btn, { backgroundColor: "#5C6BC0", opacity: loading ? 0.7 : 1 }]}
              onPress={handleSubmit}
              activeOpacity={0.85}
              disabled={loading}
            >
              <Text style={styles.btnText}>{loading ? "Saving…" : "Set New Password"}</Text>
              {!loading && <Feather name="check" size={18} color="#fff" />}
            </TouchableOpacity>

            <TouchableOpacity onPress={() => router.replace("/forgot-password")}>
              <Text style={styles.linkText}>Link expired? Request a new one</Text>
            </TouchableOpacity>
          </View>
        )}
      </KeyboardAwareScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0F1B2D", paddingHorizontal: 28 },
  scroll: { flexGrow: 1, justifyContent: "center" },
  content: { alignItems: "center", gap: 16, width: "100%" },
  iconCircle: {
    width: 96,
    height: 96,
    borderRadius: 48,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 8,
  },
  title: { color: "#fff", fontSize: 22, fontWeight: "700", textAlign: "center" },
  desc: { color: "rgba(255,255,255,0.6)", fontSize: 15, lineHeight: 24, textAlign: "center" },
  fieldLabel: { color: "rgba(255,255,255,0.7)", fontSize: 13, fontWeight: "600", marginBottom: 8 },
  inputRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.2)",
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: Platform.OS === "web" ? 12 : 10,
  },
  input: { flex: 1, color: "#fff", fontSize: 15, ...(Platform.OS === "web" ? ({ outlineStyle: "none" } as any) : null) },
  errorText: { color: "#EF9A9A", fontSize: 13 },
  btn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 16,
    borderRadius: 16,
    width: "100%",
    marginTop: 8,
  },
  btnText: { color: "#fff", fontSize: 15, fontWeight: "800" },
  linkText: { color: "#7986CB", fontSize: 14, fontWeight: "600", marginTop: 4 },
});
