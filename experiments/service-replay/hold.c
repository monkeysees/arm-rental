#define _POSIX_C_SOURCE 200809L
#include <dirent.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

// Keep one cgroup alive across worker failure/restart; instantiate fixture pages
// in service-owned tmpfs instead of borrowing the exporter's page-cache charges.
int main(void) {
    DIR *directory = opendir("/input");
    if (!directory) { perror("/input"); return 1; }
    struct dirent *entry;
    while ((entry = readdir(directory))) {
        if (entry->d_name[0] == '.') continue;
        char source[512], destination[512];
        snprintf(source, sizeof(source), "/input/%s", entry->d_name);
        snprintf(destination, sizeof(destination), "/fixtures/%s", entry->d_name);
        FILE *input = fopen(source, "rb"), *output = fopen(destination, "wb");
        if (!input || !output) { perror("fixture copy"); return 1; }
        char buffer[16384];
        size_t count;
        while ((count = fread(buffer, 1, sizeof(buffer), input))) {
            if (fwrite(buffer, 1, count, output) != count) return 1;
        }
        if (ferror(input) || fclose(input) || fclose(output)) return 1;
    }
    if (closedir(directory)) return 1;
    puts("ready");
    fflush(stdout);
    for (;;) pause();
}
