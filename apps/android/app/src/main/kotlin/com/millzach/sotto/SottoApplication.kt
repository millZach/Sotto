package com.millzach.sotto

import android.app.Application
import android.os.Build
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import com.millzach.sotto.app.AppModel
import com.millzach.sotto.core.ComputerName
import com.millzach.sotto.store.KeystoreItems
import com.millzach.sotto.store.SecureStore

// One app model for the process. It connects while Sotto is in front and lets go when it goes to the background.
class SottoApplication : Application() {
    lateinit var model: AppModel
        private set

    override fun onCreate() {
        super.onCreate()
        // The computer lists this phone by its model name, as it lists an iPhone as "iPhone".
        val name = ComputerName.cleaned(Build.MODEL) ?: "Android phone"
        model = AppModel(SecureStore(KeystoreItems(this)), name)
        ProcessLifecycleOwner.get().lifecycle.addObserver(object : DefaultLifecycleObserver {
            override fun onStart(owner: LifecycleOwner) = model.phase(foreground = true)
            override fun onStop(owner: LifecycleOwner) = model.phase(foreground = false)
        })
    }
}
