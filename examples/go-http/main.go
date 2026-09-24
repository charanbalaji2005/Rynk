package main

import (
	"fmt"
	"log"
	"net/http"
	"os"
)

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}
	host := os.Getenv("HOST")
	http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprintf(w, "<h1>Go on Rynk</h1>")
	})
	log.Printf("listening on %s:%s", host, port)
	log.Fatal(http.ListenAndServe(host+":"+port, nil))
}
