// Wellenwerk: FT8/FT4 dekodieren mit ft8_lib (Karlis Goba, MIT-Lizenz, github.com/kgoba/ft8_lib), uebersetzt nach WebAssembly.
// ww_ftx_decode(Ton, Anzahl, Abtastrate, ft4) -> Zeilen "snr<TAB>dt<TAB>Frequenz<TAB>Text\n" im Ausgabepuffer, Rueckgabe: Anzahl Nachrichten
#include <stdlib.h>
#include <string.h>
#include <stdio.h>
#include <stdbool.h>
#include <ft8/decode.h>
#include <ft8/message.h>
#include <common/monitor.h>

#define MAX_CAND 200
#define MAX_DEC 60
#define HT 256

static struct { char call[12]; uint32_t hash; } ht[HT];

static void ht_add(const char* call, uint32_t hash)
{
    int i = (((hash >> 12) & 0x3FFu) * 23) % HT;
    while (ht[i].call[0] && !((ht[i].hash & 0x3FFFFFu) == hash && !strcmp(ht[i].call, call))) i = (i + 1) % HT;
    strncpy(ht[i].call, call, 11); ht[i].call[11] = 0; ht[i].hash = hash;
}
static bool ht_lookup(ftx_callsign_hash_type_t t, uint32_t hash, char* call)
{
    uint8_t sh = (t == FTX_CALLSIGN_HASH_10_BITS) ? 12 : (t == FTX_CALLSIGN_HASH_12_BITS ? 10 : 0);
    int i = (((hash >> (12 - sh)) & 0x3FFu) * 23) % HT;
    for (int n = 0; ht[i].call[0] && n < HT; n++, i = (i + 1) % HT)
        if (((ht[i].hash & 0x3FFFFFu) >> sh) == hash) { strcpy(call, ht[i].call); return true; }
    call[0] = 0; return false;
}
static ftx_callsign_hash_interface_t hash_if = { .lookup_hash = ht_lookup, .save_hash = ht_add };

int ww_ftx_decode(const float* signal, int num_samples, int sample_rate, int ft4, char* out, int outlen)
{
    monitor_t mon;
    monitor_config_t cfg = { .f_min = 100, .f_max = (sample_rate / 2) - 200 > 3200 ? 3200 : (sample_rate / 2) - 200, .sample_rate = sample_rate,
                             .time_osr = 2, .freq_osr = 2, .protocol = ft4 ? FTX_PROTOCOL_FT4 : FTX_PROTOCOL_FT8 };
    monitor_init(&mon, &cfg);
    for (int p = 0; p + mon.block_size <= num_samples; p += mon.block_size) monitor_process(&mon, signal + p);
    ftx_candidate_t cand[MAX_CAND];
    int nc = ftx_find_candidates(&mon.wf, MAX_CAND, cand, 10);
    ftx_message_t dec[MAX_DEC]; int nd = 0, pos = 0;
    out[0] = 0;
    for (int i = 0; i < nc && nd < MAX_DEC; i++) {
        ftx_message_t msg; ftx_decode_status_t st;
        if (!ftx_decode_candidate(&mon.wf, &cand[i], 25, &msg, &st)) continue;
        bool dup = false;
        for (int k = 0; k < nd; k++) if (dec[k].hash == msg.hash && !memcmp(dec[k].payload, msg.payload, sizeof(msg.payload))) { dup = true; break; }
        if (dup) continue;
        dec[nd++] = msg;
        char text[FTX_MAX_MESSAGE_LENGTH]; ftx_message_offsets_t offs;
        if (ftx_message_decode(&msg, &hash_if, text, &offs) != FTX_MESSAGE_RC_OK) continue;
        float f = (mon.min_bin + cand[i].freq_offset + (float)cand[i].freq_sub / mon.wf.freq_osr) / mon.symbol_period;
        float t = (cand[i].time_offset + (float)cand[i].time_sub / mon.wf.time_osr) * mon.symbol_period;
        int w = snprintf(out + pos, outlen - pos, "%.1f\t%.2f\t%.0f\t%s\n", cand[i].score * 0.5f, t, f, text);
        if (w < 0 || pos + w >= outlen) break;
        pos += w;
    }
    monitor_free(&mon);
    return nd;
}
