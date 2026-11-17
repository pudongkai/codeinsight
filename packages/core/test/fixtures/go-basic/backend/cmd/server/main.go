package main

import (
	"fmt"
	"net/http"
	"os"

	"example.com/gobasic/internal/order"
)

func main() {
	svc := order.NewService(order.NewMemRepo())
	http.HandleFunc("/orders", func(w http.ResponseWriter, r *http.Request) {
		o, err := svc.Create("demo", 1)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		fmt.Fprintln(w, o.ID)
	})
	addr := os.Getenv("ADDR")
	if addr == "" {
		addr = ":8080"
	}
	_ = http.ListenAndServe(addr, nil)
}
