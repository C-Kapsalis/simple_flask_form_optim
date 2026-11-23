# 1. Re-stream your app.py to the pod (in case K8s restarted the container) 
sudo k8s kubectl exec -i -n marketing-form-dynamic-optimization marketing-form-dynamic-optimization-0 -c flask-app -- python3 -c "import sys; open('/flask/app/app.py', 'w').write(sys.stdin.read())" < \~/marketing-form-dynamic-optimization/app.py 

# 2. Restart Flask 
sudo k8s kubectl exec -n marketing-form-dynamic-optimization marketing-form-dynamic-optimization-0 -c flask-app -- /charm/bin/pebble restart flask 

# 3. Re-open the port-forward tunnel 
sudo k8s kubectl port-forward -n marketing-form-dynamic-optimization svc/marketing-form-dynamic-optimization 8080:8000 --address 0.0.0.0