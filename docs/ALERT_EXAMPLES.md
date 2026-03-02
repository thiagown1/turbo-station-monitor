# Alert Format Examples

## ❌ OLD (Before Fix)

```
🔴 Carregador em FALHA

📝 Carregador entrou em estado FAULTED
🕐 00:02

⚡ Ação: Reiniciar remotamente via plataforma
```

**Problems:**
- No charger ID
- No error details
- Generic message

---

## ✅ NEW (After Fix)

### Example 1: Charger Faulted

```
🔴 *Carregador em FALHA*

🔌 *Carregador: AR2510070008*

❌ Erro: `OverCurrentFailure`
🔧 Vendor: `3,2,1,0`
🔌 Conector: 1

📝 Received StatusNotification: status=Faulted

🕐 21:15

⚡ Ação: Reiniciar remotamente via plataforma
```

### Example 2: Recovery Alert (NEW!)

```
✅ *Carregador RECUPERADO*

🔌 *Carregador: AR2510070008*

📝 Carregador recuperado: Faulted → Available

🕐 21:32

👍 Estação voltou ao normal
```

### Example 3: User Failed to Start

```
🟡 *Usuário não conseguiu iniciar carga*

🔌 *Carregador: CP0042*

❌ Erro: `InvalidToken`
🔌 Conector: 2

📝 StartTransaction rejected

🕐 14:22

👤 Ação: Verificar logs do app/autorização
```

### Example 4: RemoteStart Failed

```
🟠 *Falha no RemoteStart (App/Plataforma)*

🔌 *Carregador: CP0015*

📝 RemoteStartTransaction rejected: Connector occupied

🕐 10:05

📱 Ação: Verificar integração app ↔ servidor
```

---

## Key Improvements

1. ✅ **Charger ID prominently displayed**
2. ✅ **Error codes extracted** (error_code, vendor_error_code)
3. ✅ **Connector number shown**
4. ✅ **Clean, concise messages**
5. ✅ **Recovery notifications** (Faulted → Healthy)
6. ✅ **Smart debounce** (1h for errors, always send recovery)
7. ✅ **Better timezone** (São Paulo time)

---

## Debounce Logic

**Problem alerts:** 1 hour cooldown per charger+type
- Same error on same charger won't spam for 1 hour

**Recovery alerts:** Always sent immediately
- Good news is never suppressed

**Example:**
```
21:15 → CP005 Faulted (sent ✅)
21:20 → CP005 Faulted (debounced 🔇, only 5min ago)
21:32 → CP005 Recovered (sent ✅, always allowed)
22:20 → CP005 Faulted again (sent ✅, >1hr since last)
```
